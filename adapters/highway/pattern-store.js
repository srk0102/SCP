// SCP Pattern Store — muscle memory for highway adapter
// Caches brain decisions locally. Once confident, replays without brain call ($0).
// Features are based on highway entity properties (kind, siren, speed, stationary).

const CONFIDENCE_THRESHOLD = 2;  // 2 matching brain decisions = trusted
const MAX_PATTERNS = 500;

class PatternStore {
  constructor() {
    this.patterns = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  // Extract matchable features from a highway Car entity
  features(entity) {
    return {
      kind: entity.kind || "unknown",
      has_siren: !!entity._hasSiren,
      is_stationary: entity.speed < 0.2,
      speed_bucket: entity.speed < 1 ? "slow" : entity.speed < 3 ? "medium" : "fast",
      is_erratic: entity._targetX !== undefined && Math.abs((entity._targetX || entity.x) - entity.x) > 5,
      is_opposite: !!entity.isOpposite,
    };
  }

  hash(f) {
    return `${f.kind}_${f.has_siren ? "siren" : "nosiren"}_${f.is_stationary ? "static" : "moving"}_${f.speed_bucket}_${f.is_erratic ? "erratic" : "steady"}_${f.is_opposite ? "opp" : "our"}`;
  }

  lookup(entity) {
    const h = this.hash(this.features(entity));
    const p = this.patterns.get(h);
    if (!p || p.count < CONFIDENCE_THRESHOLD) {
      this.misses++;
      return null;
    }
    this.hits++;
    return p.decision;
  }

  learn(entity, decision) {
    const h = this.hash(this.features(entity));
    const existing = this.patterns.get(h);
    if (!existing) {
      this.patterns.set(h, { decision, count: 1 });
      if (this.patterns.size > MAX_PATTERNS) {
        const first = this.patterns.keys().next().value;
        this.patterns.delete(first);
      }
      return;
    }
    if (existing.decision === decision) {
      existing.count = Math.min(existing.count + 1, 20);
    } else {
      existing.count = 1;
      existing.decision = decision;
    }
  }

  correct(entity, brain_decision) {
    const h = this.hash(this.features(entity));
    const p = this.patterns.get(h);
    if (p && p.decision !== brain_decision) {
      p.count = 1;
      p.decision = brain_decision;
    }
  }

  save() {
    const obj = {};
    for (const [k, v] of this.patterns) obj[k] = v;
    localStorage.setItem("scp_highway_patterns", JSON.stringify(obj));
  }

  load() {
    try {
      const raw = localStorage.getItem("scp_highway_patterns");
      if (!raw) return;
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) {
        this.patterns.set(k, v);
      }
      console.log(`[pattern-store] loaded ${this.patterns.size} highway patterns`);
    } catch {}
  }

  stats() {
    return {
      total: this.patterns.size,
      confident: [...this.patterns.values()].filter(p => p.count >= CONFIDENCE_THRESHOLD).length,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

export const patternStore = new PatternStore();
