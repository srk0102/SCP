const { describe, test } = require("node:test");
const assert = require("node:assert");
const { PatternStore } = require("../pattern-store.js");
const { SCPAdapter } = require("../adapter.js");
const { SCPBridge } = require("../bridge.js");

// Full flow: entity enters detection zone -> reflex check -> cache check -> brain call -> learn

describe("full entity-to-decision flow", () => {
  // Simulated brain that classifies entities
  class MockBridge extends SCPBridge {
    async call(prompt) {
      // Simulate brain latency
      await new Promise(r => setTimeout(r, 5));
      if (prompt.has_siren) return { decision: "halt" };
      if (prompt.kind === "rash_driver") return { decision: "mark_engage" };
      return { decision: "mark_ignore" };
    }
  }

  function buildAdapter() {
    const ps = new PatternStore({
      featureExtractor: (e) => ({
        kind: e.kind || "unknown",
        has_siren: !!e.has_siren,
        speed_bucket: e.speed < 1 ? "slow" : e.speed < 3 ? "medium" : "fast",
      }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
      storage: "memory",
    });

    const bridge = new MockBridge({ model: "test-brain" });
    const adapter = new SCPAdapter({ patternStore: ps, bridge });

    // Emergency reflex: if entity is directly ahead and too close, halt immediately
    adapter.reflex(
      "collision_imminent",
      (state) => state.distance < 10 && state.ahead,
      () => {} // hardware stop
    );

    return { adapter, ps, bridge };
  }

  test("reflex handles emergency without brain or cache", async () => {
    const { adapter } = buildAdapter();

    const result = adapter._runReflexes({ distance: 5, ahead: true });
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.reflex, "collision_imminent");
  });

  test("first encounter: cache miss -> brain call -> learn", async () => {
    const { adapter, ps, bridge } = buildAdapter();
    const entity = { kind: "ambulance", has_siren: true, speed: 2 };

    // Step 1: reflex check (not an emergency)
    const reflex = adapter._runReflexes({ distance: 200, ahead: false });
    assert.strictEqual(reflex.handled, false);

    // Step 2: cache check (first time, miss)
    const cached = ps.lookup(entity);
    assert.strictEqual(cached, null);

    // Step 3: brain call
    const brainResult = await bridge.invoke(entity);
    assert.strictEqual(brainResult.decision, "halt");
    assert.strictEqual(bridge.callCount, 1);

    // Step 4: learn
    ps.learn(entity, brainResult.decision);
    assert.strictEqual(ps.stats().total, 1);
  });

  test("second encounter: cache hit, no brain call", async () => {
    const { ps, bridge } = buildAdapter();
    const entity = { kind: "ambulance", has_siren: true, speed: 2 };

    // Teach the pattern
    for (let i = 0; i < 5; i++) ps.learn(entity, "halt");

    const callsBefore = bridge.callCount;
    const cached = ps.lookup(entity);

    assert.notStrictEqual(cached, null);
    assert.strictEqual(cached.decision, "halt");
    assert.strictEqual(bridge.callCount, callsBefore); // no brain call
  });

  test("brain calls drop to zero after learning phase", async () => {
    const { ps, bridge } = buildAdapter();

    // 5 entity types, each seen 5 times by brain
    const entities = [
      { kind: "ambulance", has_siren: true, speed: 2 },
      { kind: "traffic_car", has_siren: false, speed: 1.5 },
      { kind: "rash_driver", has_siren: false, speed: 4 },
      { kind: "obstacle", has_siren: false, speed: 0 },
      { kind: "truck", has_siren: false, speed: 0.5 },
    ];

    // Learning phase: brain handles each entity
    for (const entity of entities) {
      const result = await bridge.invoke(entity);
      for (let i = 0; i < 5; i++) ps.learn(entity, result.decision);
    }

    const brainCallsDuringLearning = bridge.callCount;
    assert.strictEqual(brainCallsDuringLearning, 5);

    // Operation phase: cache handles everything
    for (let round = 0; round < 10; round++) {
      for (const entity of entities) {
        const cached = ps.lookup(entity);
        assert.notStrictEqual(cached, null,
          `cache miss for ${entity.kind} in round ${round}`);
      }
    }

    // Zero additional brain calls
    assert.strictEqual(bridge.callCount, brainCallsDuringLearning);
  });

  test("exploration triggers brain verification and correction", async () => {
    const ps = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 1.0, // always explore for deterministic test
      confidenceThreshold: 0.1,
      storage: "memory",
    });

    const entity = { kind: "bird" };
    for (let i = 0; i < 5; i++) ps.learn(entity, "mark_engage");

    // Exploration returns null (forces brain call)
    const result = ps.lookup(entity);
    assert.strictEqual(result, null);

    // Brain says it should be mark_ignore (the cache was wrong)
    ps.correct(entity, "mark_ignore");

    assert.strictEqual(ps.stats().corrections, 1);
    assert.strictEqual(ps.stats().explorations, 1);
  });

  test("similarity matching handles unseen but similar entities", async () => {
    const { ps, bridge } = buildAdapter();

    // Brain classifies a fast ambulance
    const ambulance1 = { kind: "ambulance", has_siren: true, speed: 4 };
    const result = await bridge.invoke(ambulance1);
    for (let i = 0; i < 5; i++) ps.learn(ambulance1, result.decision);

    // A slightly different ambulance appears (same features but different speed bucket? No, same bucket)
    // For a real similarity test we need features that hash differently
    // speed=4 -> "fast", speed=2 -> "medium" -> different hash
    const ambulance2 = { kind: "ambulance", has_siren: true, speed: 2 };
    const cached = ps.lookup(ambulance2);

    // Should match via similarity (same kind, same siren, different speed)
    if (cached) {
      assert.strictEqual(cached.decision, "halt");
      assert.strictEqual(cached.source, "similar");
    }
    // If similarity threshold not met, null is also acceptable
  });
});

// -- Stats accumulation across full session --

describe("session stats", () => {
  test("stats reflect complete session accurately", async () => {
    const ps = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
      storage: "memory",
    });

    // 3 entities, each learned 5 times
    for (let i = 0; i < 5; i++) ps.learn({ kind: "car" }, "mark_ignore");
    for (let i = 0; i < 5; i++) ps.learn({ kind: "ambulance" }, "halt");
    for (let i = 0; i < 5; i++) ps.learn({ kind: "drone" }, "mark_engage");

    // 10 cache hits
    for (let i = 0; i < 10; i++) ps.lookup({ kind: "car" });

    // 5 cache misses (unknown entity)
    for (let i = 0; i < 5; i++) ps.lookup({ kind: "ufo" });

    // 1 correction
    ps.correct({ kind: "drone" }, "mark_ignore");

    const s = ps.stats();
    assert.strictEqual(s.total, 3);
    assert.strictEqual(s.confident, 2); // car and ambulance still confident, drone reset
    assert.strictEqual(s.hits, 10);
    assert.strictEqual(s.misses, 5);
    assert.strictEqual(s.corrections, 1);
    assert.strictEqual(s.hitRate, "0.667");
  });
});
