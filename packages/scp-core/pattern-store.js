// SCP Pattern Store -- muscle memory layer
// Hot cache (in-memory Map, 0.1ms) + optional warm cache (SQLite, 5ms)
// Similarity matching with confidence scoring. Exploration rate for drift detection.
// The real-time loop never waits for anything except RAM.

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_MAX_PATTERNS = 500;
const DEFAULT_EXPLORATION_RATE = 0.1;
const MAX_COUNT = 20;
const SIMILARITY_THRESHOLD = 0.8;

class PatternStore {
  /**
   * @param {object} opts
   * @param {function} opts.featureExtractor - (entity) => { key: value } feature object
   * @param {number} [opts.confidenceThreshold] - 0-1, default 0.6
   * @param {number} [opts.maxPatterns] - max hot cache entries, default 500
   * @param {number} [opts.explorationRate] - 0-1, fraction of cache hits to verify with brain, default 0.1
   * @param {string} [opts.storage] - "memory" | "localStorage" | "sqlite", default "memory"
   * @param {string} [opts.storageKey] - localStorage key or SQLite db path
   */
  constructor(opts = {}) {
    this.featureExtractor = opts.featureExtractor || null;
    this.confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.maxPatterns = opts.maxPatterns ?? DEFAULT_MAX_PATTERNS;
    this.explorationRate = opts.explorationRate ?? DEFAULT_EXPLORATION_RATE;
    this.storageMode = opts.storage || "memory";
    this.storageKey = opts.storageKey || "scp_patterns";

    // Hot cache -- in-memory Map, real-time path only
    this.patterns = new Map();

    // Stats
    this.hits = 0;
    this.misses = 0;
    this.explorations = 0;
    this.corrections = 0;

    // Warm cache -- SQLite, loaded lazily
    this._db = null;
  }

  // -- Feature extraction --

  features(entity) {
    if (this.featureExtractor) return this.featureExtractor(entity);
    // Fallback: use all own enumerable properties as features
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
  // Converts raw count (1-20) to 0-1 float

  _confidence(pattern) {
    return pattern.count / MAX_COUNT;
  }

  // -- Similarity matching --
  // Computes 0-1 similarity between two feature objects.
  // 1.0 = identical, 0.0 = completely different.

  _similarity(featA, featB) {
    const keysA = Object.keys(featA);
    const keysB = new Set(Object.keys(featB));
    const allKeys = new Set([...keysA, ...keysB]);
    if (allKeys.size === 0) return 1.0;

    let matched = 0;
    for (const k of allKeys) {
      if (!(k in featA) || !(k in featB)) continue; // missing key = no match for this dim
      const a = featA[k];
      const b = featB[k];
      if (a === b) {
        matched++;
      } else if (typeof a === "number" && typeof b === "number") {
        // Numeric proximity: use ratio-based similarity
        const max = Math.max(Math.abs(a), Math.abs(b), 1);
        const dist = Math.abs(a - b) / max;
        matched += Math.max(0, 1 - dist);
      }
      // string/boolean mismatch = 0 contribution
    }
    return matched / allKeys.size;
  }

  // -- Lookup --
  // Returns { decision, confidence, source } or null.
  // source: "exact" | "similar"

  lookup(entity) {
    const feat = this.features(entity);
    const h = this.hash(feat);

    // Fast path: exact hash match
    const exact = this.patterns.get(h);
    if (exact) {
      const conf = this._confidence(exact);
      if (conf >= this.confidenceThreshold) {
        // Exploration: randomly return null to force brain verification
        if (this.explorationRate > 0 && Math.random() < this.explorationRate) {
          this.explorations++;
          return null;
        }
        this.hits++;
        return { decision: exact.decision, confidence: conf, source: "exact" };
      }
    }

    // Slow path: similarity search over hot cache
    let bestMatch = null;
    let bestSim = 0;
    for (const [key, pattern] of this.patterns) {
      if (key === h) continue; // already checked
      const conf = this._confidence(pattern);
      if (conf < this.confidenceThreshold) continue;

      // Parse features back from the stored pattern
      const storedFeat = pattern._features;
      if (!storedFeat) continue;

      const sim = this._similarity(feat, storedFeat);
      if (sim > bestSim && sim >= SIMILARITY_THRESHOLD) {
        bestSim = sim;
        bestMatch = pattern;
      }
    }

    if (bestMatch) {
      // Exploration still applies to similar matches
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
  // Records a brain decision for an entity.

  learn(entity, decision) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const existing = this.patterns.get(h);

    if (!existing) {
      this.patterns.set(h, { decision, count: 1, _features: feat });
      this._evict();
      return;
    }

    if (existing.decision === decision) {
      existing.count = Math.min(existing.count + 1, MAX_COUNT);
    } else {
      existing.count = 1;
      existing.decision = decision;
    }
    existing._features = feat;
  }

  // -- Correct --
  // Brain disagrees with cache during exploration. Reset confidence.

  correct(entity, brainDecision) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const p = this.patterns.get(h);
    if (p && p.decision !== brainDecision) {
      p.count = 1;
      p.decision = brainDecision;
      p._features = feat;
      this.corrections++;
    }
  }

  // -- Eviction --

  _evict() {
    if (this.patterns.size <= this.maxPatterns) return;
    // Evict lowest confidence pattern
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
    if (this.storageMode === "localStorage") {
      return this._saveLocalStorage();
    }
    if (this.storageMode === "sqlite") {
      return this._saveSqlite();
    }
    // "memory" = no persistence
  }

  load() {
    if (this.storageMode === "localStorage") {
      return this._loadLocalStorage();
    }
    if (this.storageMode === "sqlite") {
      return this._loadSqlite();
    }
  }

  // -- localStorage persistence (browser adapters) --

  _saveLocalStorage() {
    try {
      const obj = {};
      for (const [k, v] of this.patterns) {
        obj[k] = { decision: v.decision, count: v.count, _features: v._features };
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
        this.patterns.set(k, v);
      }
      console.log(`[pattern-store] loaded ${this.patterns.size} patterns from localStorage`);
    } catch {}
  }

  // -- SQLite persistence (Node.js / npm package) --

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
          features TEXT
        )
      `);
    } catch (e) {
      console.error(`[pattern-store] SQLite init failed: ${e.message}`);
    }
  }

  _saveSqlite() {
    this._ensureDb();
    if (!this._db) return;
    const upsert = this._db.prepare(`
      INSERT OR REPLACE INTO patterns (hash, decision, count, features)
      VALUES (?, ?, ?, ?)
    `);
    const tx = this._db.transaction(() => {
      for (const [k, v] of this.patterns) {
        upsert.run(k, v.decision, v.count, JSON.stringify(v._features || {}));
      }
    });
    tx();
  }

  _loadSqlite() {
    this._ensureDb();
    if (!this._db) return;
    const rows = this._db.prepare("SELECT hash, decision, count, features FROM patterns").all();
    for (const row of rows) {
      let feat = {};
      try { feat = JSON.parse(row.features); } catch {}
      this.patterns.set(row.hash, {
        decision: row.decision,
        count: row.count,
        _features: feat,
      });
    }
    console.log(`[pattern-store] loaded ${this.patterns.size} patterns from SQLite`);
  }

  // -- Stats --

  stats() {
    const values = [...this.patterns.values()];
    return {
      total: this.patterns.size,
      confident: values.filter(p => this._confidence(p) >= this.confidenceThreshold).length,
      hits: this.hits,
      misses: this.misses,
      explorations: this.explorations,
      corrections: this.corrections,
      hitRate: this.hits + this.misses > 0
        ? (this.hits / (this.hits + this.misses)).toFixed(3)
        : "0.000",
    };
  }
}

module.exports = { PatternStore };
