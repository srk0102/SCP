// SCP Pattern Store -- highway adapter (10-lane divided highway)
// Thin wrapper over scp-core PatternStore with domain-specific features.
// Brain teaches once. Muscle remembers forever.

import { PatternStore } from "../../packages/scp-core/pattern-store.mjs";

const store = new PatternStore({
  confidenceThreshold: 0.1,  // ~2 out of 20 (matches original threshold of 2)
  maxPatterns: 500,
  explorationRate: 0.1,
  storage: "localStorage",
  storageKey: "scp_highway_patterns",
  featureExtractor: (entity) => ({
    kind: entity.kind || "unknown",
    has_siren: !!entity._hasSiren,
    is_stationary: entity.speed < 0.2,
    speed_bucket: entity.speed < 1 ? "slow" : entity.speed < 3 ? "medium" : "fast",
    is_erratic: entity._targetX !== undefined && Math.abs((entity._targetX || entity.x) - entity.x) > 5,
    is_opposite: !!entity.isOpposite,
  }),
});

// Backward-compatible wrapper: lookup returns decision string or null
export const patternStore = {
  lookup(entity) {
    const result = store.lookup(entity);
    return result ? result.decision : null;
  },
  learn(entity, decision) { store.learn(entity, decision); },
  correct(entity, brainDecision) { store.correct(entity, brainDecision); },
  save() { store.save(); },
  load() { store.load(); },
  stats() { return store.stats(); },
  features(entity) { return store.features(entity); },
  hash(f) { return store.hash(f); },
  _store: store,
};
