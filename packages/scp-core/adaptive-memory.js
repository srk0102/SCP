// AdaptiveMemory -- the generalization layer between PatternStore cache
// and the LLM brain.
//
// PatternStore answers exact and near-exact situations. AdaptiveMemory
// answers "this situation looks like one the LLM has already handled".
// It stores every LLM decision with its full feature vector, then on a
// later query returns the weighted-k-nearest best match above a threshold.
//
// Not a neural network. Not a separate service. A similarity-scored
// decision store with confidence that decays with bad outcomes.
//
// Decision flow in SCPBody (order matters):
//   1. reflex            hard rules, 0-5ms
//   2. PatternStore      exact match, 0.1ms
//   3. AdaptiveMemory    similarity match, 1-5ms
//   4. LLM brain         novel situations, 500ms+
//
// Storage: in-memory array + optional SQLite warm cache via better-sqlite3.

const { EventEmitter } = require("node:events");

const DEFAULT_THRESHOLD = 0.8;
const DEFAULT_MAX_HISTORY = 500;
const DEFAULT_K = 5;

class AdaptiveMemory extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {number} [opts.threshold]     minimum similarity to return a match (default 0.8)
   * @param {number} [opts.maxHistory]    max entries stored (default 500)
   * @param {number} [opts.k]             neighbors compared for weighted average (default 5)
   * @param {string} [opts.storage]       "memory" | "sqlite" (default "memory")
   * @param {string} [opts.storageKey]    path to SQLite db (default "scp_adaptive.db")
   * @param {object} [opts.weights]       per-feature weights for distance, { featureName: weight }
   * @param {number} [opts.failureThreshold] consecutive failures before purging, default 3
   */
  constructor(opts = {}) {
    super();
    this.threshold = opts.threshold ?? DEFAULT_THRESHOLD;
    this.maxHistory = opts.maxHistory ?? DEFAULT_MAX_HISTORY;
    this.k = opts.k ?? DEFAULT_K;
    this.storageMode = opts.storage || "memory";
    this.storageKey = opts.storageKey || "scp_adaptive.db";
    this.weights = opts.weights || {};
    this.failureThreshold = opts.failureThreshold ?? 3;

    // Per-entry layout:
    //   { id, features, decision, confidence, hits, successes, failures,
    //     consecutiveFailures, createdAt, updatedAt }
    this.entries = [];
    this._nextId = 1;

    this._stats = {
      hits: 0,
      misses: 0,
      stores: 0,
      purged: 0,
      totalReports: 0,
      successReports: 0,
      failureReports: 0,
    };

    this._db = null;
  }

  // -- Public API --

  /**
   * Store a decision keyed by its feature vector. If a near-duplicate
   * exists it is reinforced (confidence bumped, updatedAt touched).
   *
   * @param {object} features
   * @param {*}      decision
   * @param {*}      [outcome]    optional prior outcome (true/false) if known
   * @returns {object} stored entry
   */
  store(features, decision, outcome) {
    if (!features || typeof features !== "object") {
      throw new Error("AdaptiveMemory.store: features must be an object");
    }
    const existing = this._findNearestExact(features);
    if (existing) {
      // Same feature shape already present. Reinforce.
      existing.hits++;
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      existing.updatedAt = Date.now();
      if (outcome === true)  { existing.successes++; existing.consecutiveFailures = 0; }
      if (outcome === false) { existing.failures++; existing.consecutiveFailures++; }
      this._stats.stores++;
      return existing;
    }

    const entry = {
      id: this._nextId++,
      features: { ...features },
      decision,
      confidence: 0.6,  // starting confidence for a freshly learned decision
      hits: 0,
      successes: outcome === true ? 1 : 0,
      failures: outcome === false ? 1 : 0,
      consecutiveFailures: outcome === false ? 1 : 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.entries.push(entry);
    this._stats.stores++;
    this._evict();
    return entry;
  }

  /**
   * Look up the best match for `features`. Returns null if no match above
   * threshold. Uses weighted-k-nearest scoring; the returned decision is
   * the one from the single best neighbor, and confidence is a blend of
   * that neighbor's stored confidence and the similarity score.
   *
   * @param {object} features
   * @returns {{decision:*, confidence:number}|null}
   */
  lookup(features) {
    if (!features || typeof features !== "object" || this.entries.length === 0) {
      this._stats.misses++;
      return null;
    }

    // Score every candidate once, then take top k.
    const scored = [];
    for (const e of this.entries) {
      const sim = this._similarity(features, e.features);
      if (sim >= this.threshold) scored.push({ entry: e, sim });
    }
    if (scored.length === 0) {
      this._stats.misses++;
      return null;
    }
    scored.sort((a, b) => b.sim - a.sim);
    const top = scored.slice(0, this.k);
    const best = top[0];

    // Blended confidence: similarity * stored confidence, averaged with the
    // fraction of top-k that agree with the best decision.
    const sameDecision = top.filter((t) => sameValue(t.entry.decision, best.entry.decision)).length;
    const agreement = sameDecision / top.length;
    const conf = Math.max(0, Math.min(1, best.sim * best.entry.confidence * agreement));

    if (conf < this.threshold) {
      this._stats.misses++;
      return null;
    }

    best.entry.hits++;
    best.entry.updatedAt = Date.now();
    this._stats.hits++;
    return { decision: best.entry.decision, confidence: Number(conf.toFixed(3)) };
  }

  /**
   * Report the outcome of a previously-served decision.
   * Finds the nearest entry; reinforces or penalizes its confidence.
   * On `failureThreshold` consecutive failures the entry is purged.
   */
  report(features, success) {
    const entry = this._findNearest(features);
    this._stats.totalReports++;
    if (success) this._stats.successReports++;
    else this._stats.failureReports++;
    if (!entry) return { found: false };

    if (success) {
      entry.successes++;
      entry.consecutiveFailures = 0;
      entry.confidence = Math.min(1, entry.confidence + 0.1);
    } else {
      entry.failures++;
      entry.consecutiveFailures++;
      entry.confidence = Math.max(0, entry.confidence - 0.15);
      if (entry.consecutiveFailures >= this.failureThreshold) {
        this._purge(entry.id);
        this.emit("entry_purged", { id: entry.id, features: entry.features });
        return { found: true, purged: true };
      }
    }
    entry.updatedAt = Date.now();
    return { found: true, purged: false };
  }

  stats() {
    const totalConfidence = this.entries.reduce((s, e) => s + e.confidence, 0);
    return {
      entries: this.entries.length,
      hits: this._stats.hits,
      misses: this._stats.misses,
      stores: this._stats.stores,
      purged: this._stats.purged,
      totalReports: this._stats.totalReports,
      successReports: this._stats.successReports,
      failureReports: this._stats.failureReports,
      hitRate: (this._stats.hits + this._stats.misses) > 0
        ? Number((this._stats.hits / (this._stats.hits + this._stats.misses)).toFixed(3))
        : 0,
      avgConfidence: this.entries.length > 0
        ? Number((totalConfidence / this.entries.length).toFixed(3))
        : 0,
    };
  }

  // -- Similarity --

  _similarity(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size === 0) return 1;

    let weightSum = 0;
    let distSq = 0;

    for (const k of keys) {
      const w = this.weights[k] ?? 1;
      weightSum += w * w;

      if (!(k in a) || !(k in b)) {
        distSq += w * w; // missing feature = max distance on this dim
        continue;
      }
      const va = a[k];
      const vb = b[k];

      if (typeof va === "number" && typeof vb === "number") {
        const denom = Math.max(Math.abs(va), Math.abs(vb), 1);
        const d = (va - vb) / denom;
        distSq += (w * d) * (w * d);
      } else if (va === vb) {
        // match
      } else {
        distSq += w * w;
      }
    }

    // Convert euclidean distance in normalized space to similarity in [0,1].
    const sim = 1 - Math.sqrt(distSq / weightSum);
    return Math.max(0, Math.min(1, sim));
  }

  _findNearestExact(features) {
    for (const e of this.entries) {
      if (this._similarity(features, e.features) >= 0.999) return e;
    }
    return null;
  }

  _findNearest(features) {
    let best = null;
    let bestSim = 0;
    for (const e of this.entries) {
      const s = this._similarity(features, e.features);
      if (s > bestSim) { best = e; bestSim = s; }
    }
    return bestSim >= this.threshold ? best : null;
  }

  _purge(id) {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
      this._stats.purged++;
    }
  }

  _evict() {
    if (this.entries.length <= this.maxHistory) return;
    // Evict the entry with the lowest confidence, then the oldest updatedAt.
    let worstIdx = 0;
    let worstScore = Infinity;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const score = e.confidence * 1000 + e.updatedAt / 1e9;
      if (score < worstScore) { worstScore = score; worstIdx = i; }
    }
    this.entries.splice(worstIdx, 1);
  }

  // -- Persistence --

  save() {
    if (this.storageMode !== "sqlite") return 0;
    this._ensureDb();
    if (!this._db) return 0;
    const upsert = this._db.prepare(`
      INSERT OR REPLACE INTO adaptive_memory_decisions
        (id, features_json, decision_json, confidence, hit_count, success_count, failure_count, consecutive_failures, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this._db.transaction(() => {
      this._db.prepare("DELETE FROM adaptive_memory_decisions").run();
      for (const e of this.entries) {
        upsert.run(
          e.id, JSON.stringify(e.features), JSON.stringify(e.decision),
          e.confidence, e.hits, e.successes, e.failures, e.consecutiveFailures,
          e.createdAt, e.updatedAt
        );
      }
    });
    tx();
    return this.entries.length;
  }

  load() {
    if (this.storageMode !== "sqlite") return 0;
    this._ensureDb();
    if (!this._db) return 0;
    const rows = this._db
      .prepare("SELECT * FROM adaptive_memory_decisions ORDER BY id ASC")
      .all();
    this.entries = [];
    let maxId = 0;
    for (const row of rows) {
      let features = {}; let decision = null;
      try { features = JSON.parse(row.features_json); } catch {}
      try { decision = JSON.parse(row.decision_json); } catch {}
      this.entries.push({
        id: row.id,
        features,
        decision,
        confidence: row.confidence,
        hits: row.hit_count,
        successes: row.success_count,
        failures: row.failure_count,
        consecutiveFailures: row.consecutive_failures,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
      if (row.id > maxId) maxId = row.id;
    }
    this._nextId = maxId + 1;
    return this.entries.length;
  }

  _ensureDb() {
    if (this._db) return;
    try {
      const Database = require("better-sqlite3");
      this._db = new Database(this.storageKey);
      this._db.pragma("journal_mode = WAL");
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS adaptive_memory_decisions (
          id INTEGER PRIMARY KEY,
          features_json TEXT NOT NULL,
          decision_json TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.6,
          hit_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
    } catch (e) {
      // SQLite unavailable. Memory mode continues to work.
      this._db = null;
    }
  }
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === "object" && typeof b === "object" && a && b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
  }
  return false;
}

module.exports = { AdaptiveMemory };
