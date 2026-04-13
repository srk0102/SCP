// SCP Pattern Store -- aim-lab adapter (missile defense)
// Thin wrapper over scp-core PatternStore with domain-specific features.
// Brain teaches once. Muscle remembers forever.

import { PatternStore } from "../../packages/scp-core/pattern-store.mjs";

const store = new PatternStore({
  confidenceThreshold: 0.15,  // ~3 out of 20 (matches original threshold of 3)
  maxPatterns: 500,
  explorationRate: 0.1,
  storage: "localStorage",
  storageKey: "scp_patterns",
  featureExtractor: (entity) => ({
    has_heat: entity.has_heat,
    direction: Math.abs(entity.vx) > Math.abs(entity.vy) ? "horizontal" : "vertical",
    speed_bucket: Math.round(Math.hypot(entity.vx, entity.vy) / 20) * 20,
    y_bucket: Math.round(entity.y / 150) * 150,
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
  // Expose the underlying store for advanced usage
  _store: store,
};
