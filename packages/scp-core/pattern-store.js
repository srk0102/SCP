// SCP Pattern Store -- muscle memory layer
// Hot cache (in-memory Map, 0.1ms) + optional warm cache (SQLite, 5ms)
// Similarity matching with confidence scoring. Exploration rate for drift detection.
// Success rate monitoring with auto-invalidation on repeated failure.
// The real-time loop never waits for anything except RAM.

const { EventEmitter } = require("node:events");

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_MAX_PATTERNS = 500;
const DEFAULT_EXPLORATION_RATE = 0.1;
const DEFAULT_FAILURE_THRESHOLD = 3;
const MAX_COUNT = 20;
const SIMILARITY_THRESHOLD = 0.8;

class PatternStore extends EventEmitter {
  /**
   * @param {object} opts
   * @param {function} opts.featureExtractor - (entity) => { key: value } feature object
   * @param {number} [opts.confidenceThreshold] - 0-1, default 0.6
   * @param {number} [opts.maxPatterns] - max hot cache entries, default 500
   * @param {number} [opts.explorationRate] - 0-1, fraction of cache hits to verify with brain, default 0.1
   * @param {number} [opts.failureThreshold] - consecutive failures before auto-invalidation, default 3
   * @param {string} [opts.storage] - "memory" | "localStorage" | "sqlite", default "memory"
   * @param {string} [opts.storageKey] - localStorage key or SQLite db path
   */
  constructor(opts = {}) {
    super();
    this.featureExtractor = opts.featureExtractor || null;
    this.confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.maxPatterns = opts.maxPatterns ?? DEFAULT_MAX_PATTERNS;
    this.explorationRate = opts.explorationRate ?? DEFAULT_EXPLORATION_RATE;
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.storageMode = opts.storage || "memory";
    this.storageKey = opts.storageKey || "scp_patterns";

    // Hot cache -- in-memory Map, real-time path only
    this.patterns = new Map();

    // Stats
    this.hits = 0;
    this.misses = 0;
    this.explorations = 0;
    this.corrections = 0;
    this.invalidations = 0;
    this.totalReports = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;

    // Warm cache -- SQLite, loaded lazily
    this._db = null;
  }

  // -- Feature extraction --

  features(entity) {
    if (this.featureExtractor) return this.featureExtractor(entity);
    const f = {};
    for (const k of Object.keys(entity)) {
      const v = entity[k];
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        f[k] = v;
      }
    }
    return f;
  }

  // -- Hashing --

  hash(f) {
    const keys = Object.keys(f).sort();
    return keys.map(k => `${k}:${f[k]}`).join("|");
  }

  // -- Confidence --

  _confidence(pattern) {
    return pattern.count / MAX_COUNT;
  }

  // -- Similarity matching --

  _similarity(featA, featB) {
    const keysA = Object.keys(featA);
    const keysB = new Set(Object.keys(featB));
    const allKeys = new Set([...keysA, ...keysB]);
    if (allKeys.size === 0) return 1.0;

    let matched = 0;
    for (const k of allKeys) {
      if (!(k in featA) || !(k in featB)) continue;
      const a = featA[k];
      const b = featB[k];
      if (a === b) {
        matched++;
      } else if (typeof a === "number" && typeof b === "number") {
        const max = Math.max(Math.abs(a), Math.abs(b), 1);
        const dist = Math.abs(a - b) / max;
        matched += Math.max(0, 1 - dist);
      }
    }
    return matched / allKeys.size;
  }

  // -- Lookup --

  lookup(entity) {
    const feat = this.features(entity);
    const h = this.hash(feat);

    const exact = this.patterns.get(h);
    if (exact) {
      const conf = this._confidence(exact);
      if (conf >= this.confidenceThreshold) {
        if (this.explorationRate > 0 && Math.random() < this.explorationRate) {
          this.explorations++;
          return null;
        }
        this.hits++;
        return { decision: exact.decision, confidence: conf, source: "exact" };
      }
    }

    let bestMatch = null;
    let bestSim = 0;
    for (const [key, pattern] of this.patterns) {
      if (key === h) continue;
      const conf = this._confidence(pattern);
      if (conf < this.confidenceThreshold) continue;
      const storedFeat = pattern._features;
      if (!storedFeat) continue;
      const sim = this._similarity(feat, storedFeat);
      if (sim > bestSim && sim >= SIMILARITY_THRESHOLD) {
        bestSim = sim;
        bestMatch = pattern;
      }
    }

    if (bestMatch) {
      if (this.explorationRate > 0 && Math.random() < this.explorationRate) {
        this.explorations++;
        return null;
      }
      this.hits++;
      return {
        decision: bestMatch.decision,
        confidence: this._confidence(bestMatch) * bestSim,
        source: "similar",
      };
    }

    this.misses++;
    return null;
  }

  // -- Learn --

  learn(entity, decision) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const existing = this.patterns.get(h);

    if (!existing) {
      this.patterns.set(h, {
        decision,
        count: 1,
        _features: feat,
        successCount: 0,
        failureCount: 0,
        consecutiveFailures: 0,
      });
      this._evict();
      return;
    }

    if (existing.decision === decision) {
      existing.count = Math.min(existing.count + 1, MAX_COUNT);
    } else {
      // Decision changed -- reset confidence and outcome counters.
      existing.count = 1;
      existing.decision = decision;
      existing.successCount = 0;
      existing.failureCount = 0;
      existing.consecutiveFailures = 0;
    }
    existing._features = feat;
  }

  // -- Correct --

  correct(entity, brainDecision) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const p = this.patterns.get(h);
    if (p && p.decision !== brainDecision) {
      p.count = 1;
      p.decision = brainDecision;
      p._features = feat;
      p.successCount = 0;
      p.failureCount = 0;
      p.consecutiveFailures = 0;
      this.corrections++;
    }
  }

  // -- Report (success/failure outcome of a cached decision) --
  // The body calls this after executing whatever lookup() returned.
  // success=true  -> reinforce the pattern
  // success=false -> increment consecutive failures; auto-invalidate at threshold

  report(entity, success) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const p = this.patterns.get(h);

    this.totalReports++;
    if (success) this.totalSuccesses++;
    else this.totalFailures++;

    if (!p) return { found: false };

    if (success) {
      p.successCount = (p.successCount || 0) + 1;
      p.consecutiveFailures = 0;
      return { found: true, invalidated: false };
    }

    p.failureCount = (p.failureCount || 0) + 1;
    p.consecutiveFailures = (p.consecutiveFailures || 0) + 1;

    if (p.consecutiveFailures >= this.failureThreshold) {
      this.patterns.delete(h);
      this.invalidations++;
      this.emit("pattern_invalidated", {
        hash: h,
        features: feat,
        decision: p.decision,
        consecutiveFailures: p.consecutiveFailures,
        successCount: p.successCount,
        failureCount: p.failureCount,
      });
      return { found: true, invalidated: true };
    }

    return { found: true, invalidated: false };
  }

  // Per-pattern success rate (for inspection/tests)
  getSuccessRate(entity) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const p = this.patterns.get(h);
    if (!p) return null;
    const total = (p.successCount || 0) + (p.failureCount || 0);
    if (total === 0) return null;
    return p.successCount / total;
  }

  // -- Eviction --

  _evict() {
    if (this.patterns.size <= this.maxPatterns) return;
    let worstKey = null;
    let worstCount = Infinity;
    for (const [k, v] of this.patterns) {
      if (v.count < worstCount) {
        worstCount = v.count;
        worstKey = k;
      }
    }
    if (worstKey) this.patterns.delete(worstKey);
  }

  // -- Persistence --

  save() {
    if (this.storageMode === "localStorage") return this._saveLocalStorage();
    if (this.storageMode === "sqlite") return this._saveSqlite();
  }

  load() {
    if (this.storageMode === "localStorage") return this._loadLocalStorage();
    if (this.storageMode === "sqlite") return this._loadSqlite();
  }

  _saveLocalStorage() {
    try {
      const obj = {};
      for (const [k, v] of this.patterns) {
        obj[k] = {
          decision: v.decision,
          count: v.count,
          _features: v._features,
          successCount: v.successCount || 0,
          failureCount: v.failureCount || 0,
          consecutiveFailures: v.consecutiveFailures || 0,
        };
      }
      localStorage.setItem(this.storageKey, JSON.stringify(obj));
    } catch {}
  }

  _loadLocalStorage() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        // Backfill outcome counters if loading old data
        v.successCount ||= 0;
        v.failureCount ||= 0;
        v.consecutiveFailures ||= 0;
        this.patterns.set(k, v);
      }
      console.log(`[pattern-store] loaded ${this.patterns.size} patterns from localStorage`);
    } catch {}
  }

  _ensureDb() {
    if (this._db) return;
    try {
      const Database = require("better-sqlite3");
      this._db = new Database(this.storageKey);
      this._db.pragma("journal_mode = WAL");
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS patterns (
          hash TEXT PRIMARY KEY,
          decision TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 1,
          features TEXT,
          success_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          consecutive_failures INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Add columns if upgrading from older schema (best-effort, ignore errors)
      try { this._db.exec("ALTER TABLE patterns ADD COLUMN success_count INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this._db.exec("ALTER TABLE patterns ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0"); } catch {}
      try { this._db.exec("ALTER TABLE patterns ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0"); } catch {}
    } catch (e) {
      console.error(`[pattern-store] SQLite init failed: ${e.message}`);
    }
  }

  _saveSqlite() {
    this._ensureDb();
    if (!this._db) return;
    const upsert = this._db.prepare(`
      INSERT OR REPLACE INTO patterns
        (hash, decision, count, features, success_count, failure_count, consecutive_failures)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = this._db.transaction(() => {
      for (const [k, v] of this.patterns) {
        upsert.run(
          k, v.decision, v.count, JSON.stringify(v._features || {}),
          v.successCount || 0, v.failureCount || 0, v.consecutiveFailures || 0
        );
      }
    });
    tx();
  }

  _loadSqlite() {
    this._ensureDb();
    if (!this._db) return;
    const rows = this._db
      .prepare("SELECT hash, decision, count, features, success_count, failure_count, consecutive_failures FROM patterns")
      .all();
    for (const row of rows) {
      let feat = {};
      try { feat = JSON.parse(row.features); } catch {}
      this.patterns.set(row.hash, {
        decision: row.decision,
        count: row.count,
        _features: feat,
        successCount: row.success_count || 0,
        failureCount: row.failure_count || 0,
        consecutiveFailures: row.consecutive_failures || 0,
      });
    }
    console.log(`[pattern-store] loaded ${this.patterns.size} patterns from SQLite`);
  }

  // -- Stats --

  stats() {
    const values = [...this.patterns.values()];
    let totalReportable = 0;
    let totalSuccessRate = 0;
    let lowConfidencePatterns = 0;

    for (const p of values) {
      const total = (p.successCount || 0) + (p.failureCount || 0);
      if (total > 0) {
        const rate = p.successCount / total;
        totalSuccessRate += rate;
        totalReportable++;
        if (rate < 0.5) lowConfidencePatterns++;
      }
    }

    return {
      total: this.patterns.size,
      confident: values.filter(p => this._confidence(p) >= this.confidenceThreshold).length,
      hits: this.hits,
      misses: this.misses,
      explorations: this.explorations,
      corrections: this.corrections,
      invalidations: this.invalidations,
      totalReports: this.totalReports,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      averageSuccessRate: totalReportable > 0
        ? Number((totalSuccessRate / totalReportable).toFixed(3))
        : null,
      lowConfidencePatterns,
      hitRate: this.hits + this.misses > 0
        ? (this.hits / (this.hits + this.misses)).toFixed(3)
        : "0.000",
    };
  }
}

module.exports = { PatternStore };
