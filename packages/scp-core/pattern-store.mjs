// SCP Pattern Store -- muscle memory layer (ESM)
// Hot cache (in-memory Map, 0.1ms) + optional warm cache (SQLite, 5ms)
// Similarity matching with confidence scoring. Exploration rate for drift detection.
// Success rate monitoring with auto-invalidation on repeated failure.
// The real-time loop never waits for anything except RAM.

import { EventEmitter } from "node:events";

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;
const DEFAULT_MAX_PATTERNS = 500;
const DEFAULT_EXPLORATION_RATE = 0.1;
const DEFAULT_FAILURE_THRESHOLD = 3;
const MAX_COUNT = 20;
const SIMILARITY_THRESHOLD = 0.8;

export class PatternStore extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.featureExtractor = opts.featureExtractor || null;
    this.confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.maxPatterns = opts.maxPatterns ?? DEFAULT_MAX_PATTERNS;
    this.explorationRate = opts.explorationRate ?? DEFAULT_EXPLORATION_RATE;
    this.failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.storageMode = opts.storage || "memory";
    this.storageKey = opts.storageKey || "scp_patterns";

    this.patterns = new Map();

    this.hits = 0;
    this.misses = 0;
    this.explorations = 0;
    this.corrections = 0;
    this.invalidations = 0;
    this.totalReports = 0;
    this.totalSuccesses = 0;
    this.totalFailures = 0;
  }

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

  hash(f) {
    const keys = Object.keys(f).sort();
    return keys.map(k => `${k}:${f[k]}`).join("|");
  }

  _confidence(pattern) { return pattern.count / MAX_COUNT; }

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
      if (a === b) matched++;
      else if (typeof a === "number" && typeof b === "number") {
        const max = Math.max(Math.abs(a), Math.abs(b), 1);
        const dist = Math.abs(a - b) / max;
        matched += Math.max(0, 1 - dist);
      }
    }
    return matched / allKeys.size;
  }

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

  learn(entity, decision) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const existing = this.patterns.get(h);

    if (!existing) {
      this.patterns.set(h, {
        decision, count: 1, _features: feat,
        successCount: 0, failureCount: 0, consecutiveFailures: 0,
      });
      this._evict();
      return;
    }

    if (existing.decision === decision) {
      existing.count = Math.min(existing.count + 1, MAX_COUNT);
    } else {
      existing.count = 1;
      existing.decision = decision;
      existing.successCount = 0;
      existing.failureCount = 0;
      existing.consecutiveFailures = 0;
    }
    existing._features = feat;
  }

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

  getSuccessRate(entity) {
    const feat = this.features(entity);
    const h = this.hash(feat);
    const p = this.patterns.get(h);
    if (!p) return null;
    const total = (p.successCount || 0) + (p.failureCount || 0);
    if (total === 0) return null;
    return p.successCount / total;
  }

  _evict() {
    if (this.patterns.size <= this.maxPatterns) return;
    let worstKey = null;
    let worstCount = Infinity;
    for (const [k, v] of this.patterns) {
      if (v.count < worstCount) { worstCount = v.count; worstKey = k; }
    }
    if (worstKey) this.patterns.delete(worstKey);
  }

  save() {
    if (this.storageMode === "localStorage") {
      try {
        const obj = {};
        for (const [k, v] of this.patterns) {
          obj[k] = {
            decision: v.decision, count: v.count, _features: v._features,
            successCount: v.successCount || 0,
            failureCount: v.failureCount || 0,
            consecutiveFailures: v.consecutiveFailures || 0,
          };
        }
        localStorage.setItem(this.storageKey, JSON.stringify(obj));
      } catch {}
    }
  }

  load() {
    if (this.storageMode === "localStorage") {
      try {
        const raw = localStorage.getItem(this.storageKey);
        if (!raw) return;
        const obj = JSON.parse(raw);
        for (const [k, v] of Object.entries(obj)) {
          v.successCount ||= 0;
          v.failureCount ||= 0;
          v.consecutiveFailures ||= 0;
          this.patterns.set(k, v);
        }
        console.log(`[pattern-store] loaded ${this.patterns.size} patterns from localStorage`);
      } catch {}
    }
  }

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
