const { describe, test } = require("node:test");
const assert = require("node:assert");
const { PatternStore } = require("../pattern-store.js");
const { SCPBody } = require("../body.js");

// Minimal fake orchestrator that records body decisions
class FakeSpace {
  constructor() { this.decisions = []; this.events = []; }
  onBodyDecision(bodyName, entity, decision, meta) {
    this.decisions.push({ bodyName, entity, decision, meta });
  }
  onBodyEvent() {}
}

class CartpoleBody extends SCPBody {
  static bodyName = "cartpole";
  static tools = {
    apply_force: { description: "push", parameters: {} },
  };
  async apply_force() { return { ok: true }; }
  evaluateOutcome(state) { return Math.abs(state.angle ?? 0) < 0.5; }
}

describe("managed mode: body stays intelligent", () => {
  test("decideLocally returns cached decision in both modes", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: Math.round(e.angle * 10) / 10 }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    const e = { angle: 0.3 };
    for (let i = 0; i < 5; i++) store.learn(e, "apply_force");

    // standalone mode
    body._setMode("standalone");
    const standaloneResult = body.decideLocally(e);
    assert.strictEqual(standaloneResult.decision, "apply_force");

    // managed mode -- same decision
    body._setMode("managed");
    const managedResult = body.decideLocally(e);
    assert.strictEqual(managedResult.decision, "apply_force");
  });

  test("decideLocally notifies Space in managed mode", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: e.angle }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    const fake = new FakeSpace();
    body._attachSpace(fake);

    const e = { angle: 0.3 };
    for (let i = 0; i < 5; i++) store.learn(e, "apply_force");

    body.decideLocally(e);

    assert.strictEqual(fake.decisions.length, 1);
    assert.strictEqual(fake.decisions[0].bodyName, "cartpole");
    assert.strictEqual(fake.decisions[0].decision, "apply_force");
    assert.ok(fake.decisions[0].meta.source);
  });

  test("decideLocally notifies even in standalone mode if space attached", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: e.angle }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    const fake = new FakeSpace();
    body._attachSpace(fake);
    body._setMode("standalone"); // override attach mode

    const e = { angle: 0.3 };
    for (let i = 0; i < 5; i++) store.learn(e, "apply_force");

    body.decideLocally(e);
    assert.strictEqual(fake.decisions.length, 1);
  });

  test("decideLocally returns null on cache miss (brain will be consulted)", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: e.angle }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    const fake = new FakeSpace();
    body._attachSpace(fake);

    // No patterns learned -- cache miss
    const result = body.decideLocally({ angle: 0.0 });
    assert.strictEqual(result, null);
    assert.strictEqual(fake.decisions.length, 0);
  });

  test("notifyDecision is safe without an attached Space", () => {
    const body = new CartpoleBody();
    // Should not throw
    body.notifyDecision({ x: 1 }, "foo", { source: "cache" });
    assert.ok(true);
  });

  test("cache hit remembers entity for later outcome reporting", async () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: e.angle }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    const e = { angle: 0.3 };
    for (let i = 0; i < 5; i++) store.learn(e, "apply_force");

    body.decideLocally(e);
    body.setState({ angle: 0.3 }); // within threshold -> success
    await body.invokeTool("apply_force", {});

    assert.strictEqual(store.totalSuccesses, 1);
  });

  test("body still learns in managed mode", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: e.angle }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    const fake = new FakeSpace();
    body._attachSpace(fake);
    assert.strictEqual(body.mode, "managed");

    // Body can still learn new patterns even when managed
    store.learn({ angle: 0.1 }, "apply_force");
    store.learn({ angle: 0.2 }, "apply_force");
    assert.strictEqual(store.patterns.size, 2);
  });

  test("meta includes source and confidence", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: e.angle }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    const fake = new FakeSpace();
    body._attachSpace(fake);

    const e = { angle: 0.3 };
    for (let i = 0; i < 10; i++) store.learn(e, "apply_force");

    body.decideLocally(e);
    const meta = fake.decisions[0].meta;
    assert.strictEqual(meta.source, "exact");
    assert.ok(typeof meta.confidence === "number");
    assert.ok(meta.confidence > 0);
  });
});
