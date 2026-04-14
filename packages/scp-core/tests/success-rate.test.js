const { describe, test } = require("node:test");
const assert = require("node:assert");
const { PatternStore } = require("../pattern-store.js");
const { SCPBody } = require("../body.js");

function makeStore(overrides = {}) {
  return new PatternStore({
    featureExtractor: (e) => ({
      has_heat: e.has_heat,
      direction: Math.abs(e.vx) > Math.abs(e.vy) ? "horizontal" : "vertical",
      speed_bucket: Math.round(Math.hypot(e.vx, e.vy) / 20) * 20,
      y_bucket: Math.round(e.y / 150) * 150,
    }),
    confidenceThreshold: 0.15,
    explorationRate: 0,
    storage: "memory",
    ...overrides,
  });
}

// ============================================================
// report() outcome tracking
// ============================================================

describe("report() outcome tracking", () => {
  test("report success increments successCount", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    const r = store.report(e, true);
    assert.strictEqual(r.found, true);
    assert.strictEqual(r.invalidated, false);
    assert.strictEqual(store.totalSuccesses, 1);
    assert.strictEqual(store.totalFailures, 0);
  });

  test("report failure increments failureCount and consecutive", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    store.report(e, false);
    store.report(e, false);
    assert.strictEqual(store.totalFailures, 2);
    const h = store.hash(store.features(e));
    const p = store.patterns.get(h);
    assert.strictEqual(p.failureCount, 2);
    assert.strictEqual(p.consecutiveFailures, 2);
  });

  test("success resets consecutive failure counter", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    store.report(e, false);
    store.report(e, false);
    store.report(e, true);
    const h = store.hash(store.features(e));
    const p = store.patterns.get(h);
    assert.strictEqual(p.consecutiveFailures, 0);
    assert.strictEqual(p.failureCount, 2);
    assert.strictEqual(p.successCount, 1);
  });

  test("3 consecutive failures invalidates pattern (default)", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    const h = store.hash(store.features(e));
    assert.ok(store.patterns.has(h));
    store.report(e, false);
    store.report(e, false);
    const r = store.report(e, false);
    assert.strictEqual(r.invalidated, true);
    assert.strictEqual(store.patterns.has(h), false);
    assert.strictEqual(store.invalidations, 1);
  });

  test("custom failureThreshold respected", () => {
    const store = makeStore({ failureThreshold: 5 });
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    for (let i = 0; i < 4; i++) {
      const r = store.report(e, false);
      assert.strictEqual(r.invalidated, false);
    }
    const r = store.report(e, false);
    assert.strictEqual(r.invalidated, true);
  });

  test("invalidation emits pattern_invalidated event", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    let evt = null;
    store.on("pattern_invalidated", (payload) => { evt = payload; });
    for (let i = 0; i < 3; i++) store.report(e, false);
    assert.ok(evt);
    assert.strictEqual(evt.decision, "mark_ignore");
    assert.strictEqual(evt.consecutiveFailures, 3);
  });

  test("invalidated pattern triggers brain (lookup returns null)", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    assert.notStrictEqual(store.lookup(e), null);
    for (let i = 0; i < 3; i++) store.report(e, false);
    assert.strictEqual(store.lookup(e), null);
  });

  test("report on unknown entity returns found=false", () => {
    const store = makeStore();
    const r = store.report({ has_heat: false, vx: 0, vy: 0, y: 0 }, true);
    assert.strictEqual(r.found, false);
    assert.strictEqual(store.totalReports, 1);
  });

  test("getSuccessRate returns null for unseen pattern", () => {
    const store = makeStore();
    assert.strictEqual(
      store.getSuccessRate({ has_heat: false, vx: 0, vy: 0, y: 0 }),
      null
    );
  });

  test("getSuccessRate returns null when no reports yet", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    store.learn(e, "mark_ignore");
    assert.strictEqual(store.getSuccessRate(e), null);
  });

  test("getSuccessRate returns ratio after reports", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    store.report(e, true);
    store.report(e, true);
    store.report(e, false);
    assert.strictEqual(store.getSuccessRate(e), 2 / 3);
  });

  test("learn() with same decision preserves outcome counters", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    store.report(e, true);
    store.report(e, false);
    store.learn(e, "mark_ignore");
    const h = store.hash(store.features(e));
    const p = store.patterns.get(h);
    assert.strictEqual(p.successCount, 1);
    assert.strictEqual(p.failureCount, 1);
  });

  test("learn() with different decision resets outcome counters", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    store.report(e, true);
    store.report(e, false);
    store.learn(e, "mark_engage");
    const h = store.hash(store.features(e));
    const p = store.patterns.get(h);
    assert.strictEqual(p.successCount, 0);
    assert.strictEqual(p.failureCount, 0);
    assert.strictEqual(p.consecutiveFailures, 0);
  });

  test("correct() also resets outcome counters", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    store.report(e, true);
    store.correct(e, "mark_engage");
    const h = store.hash(store.features(e));
    const p = store.patterns.get(h);
    assert.strictEqual(p.successCount, 0);
    assert.strictEqual(p.failureCount, 0);
  });
});

// ============================================================
// stats includes success metrics
// ============================================================

describe("stats includes success metrics", () => {
  test("stats includes invalidations count", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    for (let i = 0; i < 3; i++) store.report(e, false);
    assert.strictEqual(store.stats().invalidations, 1);
  });

  test("stats includes totalReports/totalSuccesses/totalFailures", () => {
    const store = makeStore();
    const e1 = { has_heat: true, vx: 80, vy: 10, y: 640 };
    const e2 = { has_heat: false, vx: 5, vy: 80, y: 200 };
    for (let i = 0; i < 5; i++) store.learn(e1, "ignore");
    for (let i = 0; i < 5; i++) store.learn(e2, "engage");
    store.report(e1, true);
    store.report(e1, true);
    store.report(e2, false);
    const s = store.stats();
    assert.strictEqual(s.totalReports, 3);
    assert.strictEqual(s.totalSuccesses, 2);
    assert.strictEqual(s.totalFailures, 1);
  });

  test("averageSuccessRate is null when no reports", () => {
    const store = makeStore();
    assert.strictEqual(store.stats().averageSuccessRate, null);
  });

  test("averageSuccessRate computed across reportable patterns", () => {
    const store = makeStore();
    const e1 = { has_heat: true, vx: 80, vy: 10, y: 640 };
    const e2 = { has_heat: false, vx: 5, vy: 80, y: 200 };
    for (let i = 0; i < 5; i++) store.learn(e1, "a");
    for (let i = 0; i < 5; i++) store.learn(e2, "b");
    store.report(e1, true);
    store.report(e1, true);
    store.report(e2, false);
    store.report(e2, false);
    // e2 will be invalidated after 3 consecutive failures, but only 2 here
    // e1: 100% success (1.0), e2: 0% success (0.0) -> avg 0.5
    assert.strictEqual(store.stats().averageSuccessRate, 0.5);
  });

  test("lowConfidencePatterns counts patterns with success rate < 0.5", () => {
    const store = makeStore({ failureThreshold: 99 }); // disable invalidation
    const e1 = { has_heat: true, vx: 80, vy: 10, y: 640 };
    const e2 = { has_heat: false, vx: 5, vy: 80, y: 200 };
    for (let i = 0; i < 5; i++) store.learn(e1, "a");
    for (let i = 0; i < 5; i++) store.learn(e2, "b");
    // e1: 100% success
    store.report(e1, true);
    store.report(e1, true);
    // e2: 25% success
    store.report(e2, true);
    store.report(e2, false);
    store.report(e2, false);
    store.report(e2, false);
    const s = store.stats();
    assert.strictEqual(s.lowConfidencePatterns, 1);
  });
});

// ============================================================
// PatternStore is an EventEmitter
// ============================================================

describe("PatternStore EventEmitter", () => {
  test("emits pattern_invalidated event on invalidation", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    let count = 0;
    store.on("pattern_invalidated", () => { count++; });
    for (let i = 0; i < 3; i++) store.report(e, false);
    assert.strictEqual(count, 1);
  });

  test("multiple listeners both fire", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    let a = 0, b = 0;
    store.on("pattern_invalidated", () => { a++; });
    store.on("pattern_invalidated", () => { b++; });
    for (let i = 0; i < 3; i++) store.report(e, false);
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 1);
  });

  test("event payload includes decision and counts", () => {
    const store = makeStore();
    const e = { has_heat: true, vx: 80, vy: 10, y: 640 };
    for (let i = 0; i < 5; i++) store.learn(e, "mark_ignore");
    store.report(e, true); // 1 success
    let evt = null;
    store.on("pattern_invalidated", (p) => { evt = p; });
    for (let i = 0; i < 3; i++) store.report(e, false);
    assert.strictEqual(evt.decision, "mark_ignore");
    assert.strictEqual(evt.successCount, 1);
    assert.strictEqual(evt.failureCount, 3);
  });
});

// ============================================================
// SCPBody integration with auto-report
// ============================================================

describe("SCPBody auto-report integration", () => {
  class CartpoleBody extends SCPBody {
    static bodyName = "cartpole";
    static tools = {
      apply_force: { description: "push", parameters: {} },
    };
    constructor(opts = {}) {
      super(opts);
      this.angle = 0;
    }
    async apply_force() { return { ok: true }; }
    evaluateOutcome(state) {
      return Math.abs(state.angle ?? 0) < 0.5;
    }
  }

  function entityFor(body) {
    return { angle: body.angle };
  }

  test("evaluateOutcome default returns null (skip reporting)", () => {
    const b = new SCPBody({ name: "x" });
    assert.strictEqual(b.evaluateOutcome({}), null);
  });

  test("invokeTool reports success when evaluateOutcome returns true", async () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ angle_bucket: Math.round((e.angle ?? 0) * 4) / 4 }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    body.angle = 0.1;
    const e = entityFor(body);
    store.learn(e, "apply_force");
    body.rememberCachedEntity(e);
    body.setState({ angle: 0.1 });
    await body.invokeTool("apply_force", {});
    assert.strictEqual(store.totalSuccesses, 1);
    assert.strictEqual(store.totalFailures, 0);
  });

  test("invokeTool reports failure when evaluateOutcome returns false", async () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ angle_bucket: Math.round((e.angle ?? 0) * 4) / 4 }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    body.angle = 1.0;
    const e = entityFor(body);
    store.learn(e, "apply_force");
    body.rememberCachedEntity(e);
    body.setState({ angle: 1.0 });
    await body.invokeTool("apply_force", {});
    assert.strictEqual(store.totalFailures, 1);
  });

  test("body.stats.reports increments per evaluated tool call", async () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ a: e.angle }),
      confidenceThreshold: 0.05,
      explorationRate: 0,
    });
    const body = new CartpoleBody({ patternStore: store });
    body.setState({ angle: 0.1 });
    body.rememberCachedEntity({ angle: 0.1 });
    store.learn({ angle: 0.1 }, "apply_force");
    await body.invokeTool("apply_force", {});
    assert.strictEqual(body.stats.reports, 1);
  });

  test("no patternStore -> no auto-report", async () => {
    const body = new CartpoleBody();
    body.setState({ angle: 0.1 });
    await body.invokeTool("apply_force", {});
    assert.strictEqual(body.stats.reports, 0);
  });

  test("evaluateOutcome returning null is skipped", async () => {
    class SilentBody extends SCPBody {
      static tools = { do_thing: { description: "x", parameters: {} } };
      constructor(opts = {}) { super({ name: "silent", ...opts }); }
      async do_thing() { return { ok: true }; }
      // default evaluateOutcome returns null
    }
    const store = new PatternStore({
      featureExtractor: (e) => ({ x: e.x }),
      explorationRate: 0,
    });
    const body = new SilentBody({ patternStore: store });
    body.rememberCachedEntity({ x: 1 });
    store.learn({ x: 1 }, "do_thing");
    await body.invokeTool("do_thing", {});
    assert.strictEqual(store.totalReports, 0);
  });
});
