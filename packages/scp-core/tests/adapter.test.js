const { describe, test } = require("node:test");
const assert = require("node:assert");
const { SCPAdapter } = require("../adapter.js");
const { PatternStore } = require("../pattern-store.js");

// -- Reflex layer --

describe("reflex layer", () => {
  test("reflex fires before pattern store check", () => {
    const order = [];

    const ps = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,
      confidenceThreshold: 0.05,
    });

    // Teach pattern store so it would return a result
    for (let i = 0; i < 5; i++) ps.learn({ kind: "obstacle" }, "mark_engage");

    // Wrap lookup to record order
    const originalLookup = ps.lookup.bind(ps);
    ps.lookup = (entity) => {
      order.push("pattern_store");
      return originalLookup(entity);
    };

    const adapter = new SCPAdapter({ patternStore: ps });

    adapter.reflex("emergency_stop", (state) => {
      if (state.pressure > 100) {
        order.push("reflex");
        return true; // signal handled
      }
    });

    // Run reflexes first (as the real loop would)
    const reflexResult = adapter._runReflexes({ pressure: 150 });
    order.push("reflex_done");

    // Then check pattern store
    ps.lookup({ kind: "obstacle" });

    assert.deepStrictEqual(order, ["reflex", "reflex_done", "pattern_store"]);
  });

  test("reflex with test/action form fires correctly", () => {
    const adapter = new SCPAdapter();
    let actionFired = false;

    adapter.reflex(
      "overheat",
      (state) => state.temp > 200,
      (state) => { actionFired = true; }
    );

    const result = adapter._runReflexes({ temp: 250 });
    assert.strictEqual(result.handled, true);
    assert.strictEqual(result.reflex, "overheat");
    assert.strictEqual(actionFired, true);
  });

  test("reflex does not fire when condition false", () => {
    const adapter = new SCPAdapter();
    let actionFired = false;

    adapter.reflex(
      "overheat",
      (state) => state.temp > 200,
      (state) => { actionFired = true; }
    );

    const result = adapter._runReflexes({ temp: 50 });
    assert.strictEqual(result.handled, false);
    assert.strictEqual(actionFired, false);
  });

  test("multiple reflexes checked in registration order", () => {
    const adapter = new SCPAdapter();
    const fired = [];

    adapter.reflex("first", (state) => state.a, () => { fired.push("first"); });
    adapter.reflex("second", (state) => state.b, () => { fired.push("second"); });

    // Both conditions true, but first should win (short-circuit)
    const result = adapter._runReflexes({ a: true, b: true });
    assert.strictEqual(result.reflex, "first");
    assert.deepStrictEqual(fired, ["first"]);
  });
});

// -- Pattern store integration --

describe("adapter pattern store", () => {
  test("accepts PatternStore instance in constructor", () => {
    const ps = new PatternStore({ storage: "memory" });
    const adapter = new SCPAdapter({ patternStore: ps });
    assert.strictEqual(adapter.patternStore, ps);
  });

  test("creates PatternStore from options when not an instance", () => {
    const adapter = new SCPAdapter({
      patternStore: { storage: "memory", maxPatterns: 100 },
    });
    assert.ok(adapter.patternStore instanceof PatternStore);
    assert.strictEqual(adapter.patternStore.maxPatterns, 100);
  });

  test("creates default PatternStore when nothing provided", () => {
    const adapter = new SCPAdapter();
    assert.ok(adapter.patternStore instanceof PatternStore);
  });

  test("features() sets the extractor on pattern store", () => {
    const adapter = new SCPAdapter();
    const extractor = (e) => ({ kind: e.kind });
    adapter.features(extractor);
    assert.strictEqual(adapter.patternStore.featureExtractor, extractor);
  });
});

// -- Muscle-brain flow --

describe("muscle-brain decision flow", () => {
  test("pattern store checked before brain escalation", () => {
    const order = [];

    const ps = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
    });

    // Teach it
    for (let i = 0; i < 5; i++) ps.learn({ kind: "car" }, "mark_ignore");

    // Simulate the adapter loop logic:
    // 1. Check reflexes -> no match
    // 2. Check pattern store -> hit
    // 3. If null, call brain

    const adapter = new SCPAdapter({ patternStore: ps });

    function processEntity(entity) {
      // Step 1: reflexes
      const reflex = adapter._runReflexes(entity);
      if (reflex.handled) { order.push("reflex"); return; }

      // Step 2: pattern store
      const cached = ps.lookup(entity);
      if (cached) { order.push("cache_hit"); return cached; }

      // Step 3: brain (simulated)
      order.push("brain_call");
      return { decision: "mark_ignore" };
    }

    processEntity({ kind: "car" });
    assert.deepStrictEqual(order, ["cache_hit"]);
  });

  test("brain called when pattern store returns null", () => {
    const order = [];

    const ps = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
    });
    // No patterns learned -- cache will miss

    const adapter = new SCPAdapter({ patternStore: ps });

    function processEntity(entity) {
      const reflex = adapter._runReflexes(entity);
      if (reflex.handled) { order.push("reflex"); return; }

      const cached = ps.lookup(entity);
      if (cached) { order.push("cache_hit"); return cached; }

      order.push("brain_call");
      const brainDecision = "mark_engage";
      ps.learn(entity, brainDecision);
      order.push("learn");
      return { decision: brainDecision };
    }

    processEntity({ kind: "drone" });
    assert.deepStrictEqual(order, ["brain_call", "learn"]);
  });

  test("learn() called after every brain decision", () => {
    const ps = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
    });

    assert.strictEqual(ps.stats().total, 0);

    // Simulate 3 brain decisions
    ps.learn({ kind: "car" }, "mark_ignore");
    ps.learn({ kind: "ambulance" }, "halt");
    ps.learn({ kind: "drone" }, "mark_engage");

    assert.strictEqual(ps.stats().total, 3);
  });

  test("correct() called when brain contradicts cache during exploration", () => {
    const ps = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0, // we simulate exploration manually
      confidenceThreshold: 0.05,
    });

    const entity = { kind: "stealth" };
    for (let i = 0; i < 5; i++) ps.learn(entity, "mark_engage");

    // Simulate: exploration forced a brain call, brain says different
    const cached = ps.lookup(entity);
    assert.strictEqual(cached.decision, "mark_engage");

    const brainSays = "mark_ignore"; // brain changed its mind
    ps.correct(entity, brainSays);

    assert.strictEqual(ps.stats().corrections, 1);

    // After re-learning with enough confidence, it should reflect the correction
    for (let i = 0; i < 5; i++) ps.learn(entity, brainSays);
    const updated = ps.lookup(entity);
    assert.strictEqual(updated.decision, "mark_ignore");
  });
});

// -- Lifecycle --

describe("adapter lifecycle", () => {
  test("start() and stop() set running state", async () => {
    const adapter = new SCPAdapter();
    assert.strictEqual(adapter._running, false);

    await adapter.start();
    assert.strictEqual(adapter._running, true);

    adapter.stop();
    assert.strictEqual(adapter._running, false);
  });

  test("onStart and onStop hooks called", async () => {
    const hooks = [];

    class TestAdapter extends SCPAdapter {
      onStart() { hooks.push("start"); }
      onStop() { hooks.push("stop"); }
    }

    const adapter = new TestAdapter();
    await adapter.start();
    adapter.stop();

    assert.deepStrictEqual(hooks, ["start", "stop"]);
  });
});
