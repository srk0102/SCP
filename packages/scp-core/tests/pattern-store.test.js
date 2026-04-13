const { describe, test } = require("node:test");
const assert = require("node:assert");
const { PatternStore } = require("../pattern-store.js");

// Helper: build a store with aim-lab-style feature extractor, no exploration
function makeStore(overrides = {}) {
  return new PatternStore({
    featureExtractor: (e) => ({
      has_heat: e.has_heat,
      direction: Math.abs(e.vx) > Math.abs(e.vy) ? "horizontal" : "vertical",
      speed_bucket: Math.round(Math.hypot(e.vx, e.vy) / 20) * 20,
      y_bucket: Math.round(e.y / 150) * 150,
    }),
    confidenceThreshold: 0.15, // 3/20
    explorationRate: 0,
    storage: "memory",
    ...overrides,
  });
}

// -- Exact match --

describe("exact match", () => {
  test("returns correct decision after enough learns", () => {
    const store = makeStore();
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    store.learn(entity, "mark_ignore");
    store.learn(entity, "mark_ignore");
    store.learn(entity, "mark_ignore");

    const result = store.lookup(entity);
    assert.strictEqual(result.decision, "mark_ignore");
    assert.strictEqual(result.source, "exact");
  });

  test("returns null when confidence too low", () => {
    const store = makeStore();
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    store.learn(entity, "mark_ignore"); // count=1, conf=0.05

    const result = store.lookup(entity);
    assert.strictEqual(result, null);
  });

  test("different decisions for different feature combos", () => {
    const store = makeStore();
    const missile = { has_heat: true, vx: 10, vy: 80, y: 200 };
    const plane = { has_heat: false, vx: 80, vy: 5, y: 600 };

    for (let i = 0; i < 4; i++) store.learn(missile, "mark_engage");
    for (let i = 0; i < 4; i++) store.learn(plane, "mark_ignore");

    assert.strictEqual(store.lookup(missile).decision, "mark_engage");
    assert.strictEqual(store.lookup(plane).decision, "mark_ignore");
  });
});

// -- Similarity match --

describe("similarity match", () => {
  test("fires when hash misses but features are close", () => {
    const store = makeStore();
    const entity1 = { has_heat: true, vx: 80, vy: 10, y: 640 };
    // entity2: same hash bucket for speed (80) and y (600), same heat and direction
    // but slightly different raw values so hash differs on y_bucket
    const entity2 = { has_heat: true, vx: 80, vy: 10, y: 710 };
    // entity1 y_bucket = round(640/150)*150 = 600
    // entity2 y_bucket = round(710/150)*150 = 750 -> different hash

    for (let i = 0; i < 5; i++) store.learn(entity1, "mark_ignore");

    const result = store.lookup(entity2);
    assert.notStrictEqual(result, null, "similar entity should match");
    assert.strictEqual(result.decision, "mark_ignore");
    assert.strictEqual(result.source, "similar");
  });

  test("confidence is reduced for similar matches", () => {
    const store = makeStore();
    const entity1 = { has_heat: true, vx: 80, vy: 10, y: 640 };
    const entity2 = { has_heat: true, vx: 80, vy: 10, y: 710 };

    for (let i = 0; i < 10; i++) store.learn(entity1, "mark_ignore");

    const exact = store.lookup(entity1);
    const similar = store.lookup(entity2);

    assert.ok(similar.confidence < exact.confidence,
      `similar confidence (${similar.confidence}) should be less than exact (${exact.confidence})`);
  });

  test("does NOT fire when features too different", () => {
    const store = makeStore();
    const plane = { has_heat: false, vx: 80, vy: 5, y: 640 };
    const missile = { has_heat: true, vx: 5, vy: 90, y: 100 };

    for (let i = 0; i < 5; i++) store.learn(plane, "mark_ignore");

    const result = store.lookup(missile);
    assert.strictEqual(result, null, "very different entity should not match");
  });

  test("prefers higher similarity match when multiple exist", () => {
    const store = makeStore();
    // Two different trained patterns
    const a = { has_heat: true, vx: 80, vy: 10, y: 300 };  // y_bucket=300
    const b = { has_heat: true, vx: 80, vy: 10, y: 900 };  // y_bucket=900

    for (let i = 0; i < 5; i++) store.learn(a, "mark_engage");
    for (let i = 0; i < 5; i++) store.learn(b, "mark_ignore");

    // Query close to a (y_bucket=450 vs a's 300), far from b (900)
    const query = { has_heat: true, vx: 80, vy: 10, y: 375 };
    const result = store.lookup(query);

    if (result) {
      // If similarity fires, it should match a not b
      assert.strictEqual(result.decision, "mark_engage");
    }
    // It's also acceptable for it to return null if neither meets SIMILARITY_THRESHOLD
  });
});

// -- Confidence scoring --

describe("confidence scoring", () => {
  test("builds correctly over N decisions", () => {
    const store = makeStore({ confidenceThreshold: 0.0 }); // accept any confidence
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    store.learn(entity, "mark_ignore"); // count=1
    const r1 = store.lookup(entity);
    assert.strictEqual(r1.confidence, 1 / 20);

    store.learn(entity, "mark_ignore"); // count=2
    const r2 = store.lookup(entity);
    assert.strictEqual(r2.confidence, 2 / 20);

    for (let i = 0; i < 18; i++) store.learn(entity, "mark_ignore"); // count=20
    const r3 = store.lookup(entity);
    assert.strictEqual(r3.confidence, 1.0);
  });

  test("caps at 1.0 even after many learns", () => {
    const store = makeStore({ confidenceThreshold: 0.0 });
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    for (let i = 0; i < 50; i++) store.learn(entity, "mark_ignore");
    const result = store.lookup(entity);
    assert.strictEqual(result.confidence, 1.0);
  });
});

// -- Contradiction handling --

describe("contradiction", () => {
  test("correct() resets confidence", () => {
    const store = makeStore();
    const entity = { has_heat: false, vx: 5, vy: 80, y: 200 };

    for (let i = 0; i < 5; i++) store.learn(entity, "mark_engage");
    assert.notStrictEqual(store.lookup(entity), null); // should hit

    store.correct(entity, "mark_ignore");

    // confidence reset to 1/20 = 0.05, below threshold 0.15
    const result = store.lookup(entity);
    assert.strictEqual(result, null, "confidence should be too low after correction");
  });

  test("correct() changes the stored decision", () => {
    const store = makeStore({ confidenceThreshold: 0.0 });
    const entity = { has_heat: false, vx: 5, vy: 80, y: 200 };

    for (let i = 0; i < 5; i++) store.learn(entity, "mark_engage");
    store.correct(entity, "mark_ignore");

    const result = store.lookup(entity);
    assert.strictEqual(result.decision, "mark_ignore");
  });

  test("learn() with different decision resets count", () => {
    const store = makeStore({ confidenceThreshold: 0.0 });
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    for (let i = 0; i < 10; i++) store.learn(entity, "mark_engage");
    const before = store.lookup(entity);
    assert.strictEqual(before.confidence, 10 / 20);

    store.learn(entity, "mark_ignore"); // contradicts, resets to count=1
    const after = store.lookup(entity);
    assert.strictEqual(after.decision, "mark_ignore");
    assert.strictEqual(after.confidence, 1 / 20);
  });

  test("corrections stat increments on correct()", () => {
    const store = makeStore();
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    for (let i = 0; i < 5; i++) store.learn(entity, "mark_engage");
    assert.strictEqual(store.stats().corrections, 0);

    store.correct(entity, "mark_ignore");
    assert.strictEqual(store.stats().corrections, 1);
  });
});

// -- Exploration rate --

describe("exploration rate", () => {
  test("fires approximately 10 percent of lookups", () => {
    const store = makeStore({
      explorationRate: 0.1,
      confidenceThreshold: 0.05,
    });
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    for (let i = 0; i < 20; i++) store.learn(entity, "mark_ignore");

    let nullCount = 0;
    const runs = 2000;
    for (let i = 0; i < runs; i++) {
      if (store.lookup(entity) === null) nullCount++;
    }

    // Expect ~10%, allow 5-15% range
    assert.ok(nullCount > runs * 0.05,
      `exploration too low: ${nullCount}/${runs} = ${(nullCount / runs * 100).toFixed(1)}%`);
    assert.ok(nullCount < runs * 0.15,
      `exploration too high: ${nullCount}/${runs} = ${(nullCount / runs * 100).toFixed(1)}%`);
  });

  test("zero exploration rate never returns null for confident patterns", () => {
    const store = makeStore({ explorationRate: 0 });
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    for (let i = 0; i < 5; i++) store.learn(entity, "mark_ignore");

    for (let i = 0; i < 100; i++) {
      assert.notStrictEqual(store.lookup(entity), null);
    }
  });

  test("exploration increments explorations stat", () => {
    const store = makeStore({
      explorationRate: 1.0, // always explore
      confidenceThreshold: 0.05,
    });
    const entity = { has_heat: true, vx: 80, vy: 10, y: 640 };

    for (let i = 0; i < 5; i++) store.learn(entity, "mark_ignore");

    store.lookup(entity);
    store.lookup(entity);
    store.lookup(entity);

    assert.strictEqual(store.stats().explorations, 3);
  });
});

// -- Smart eviction --

describe("smart eviction", () => {
  test("removes lowest confidence pattern, not oldest", () => {
    const store = makeStore({ maxPatterns: 3 });

    const e1 = { has_heat: true, vx: 80, vy: 10, y: 150 };
    const e2 = { has_heat: false, vx: 20, vy: 60, y: 300 };
    const e3 = { has_heat: true, vx: 40, vy: 40, y: 600 };

    // e1: learn 5 times (high confidence)
    for (let i = 0; i < 5; i++) store.learn(e1, "mark_engage");
    // e2: learn 1 time (low confidence) -- inserted second
    store.learn(e2, "mark_ignore");
    // e3: learn 3 times (medium confidence)
    for (let i = 0; i < 3; i++) store.learn(e3, "mark_engage");

    assert.strictEqual(store.patterns.size, 3);

    // Add e4 -- should evict e2 (lowest confidence), not e1 (oldest)
    const e4 = { has_heat: false, vx: 70, vy: 10, y: 900 };
    for (let i = 0; i < 4; i++) store.learn(e4, "mark_ignore");

    assert.strictEqual(store.patterns.size, 3);

    // e1 (high conf) should survive
    const r1 = store.lookup(e1);
    assert.notStrictEqual(r1, null, "high confidence e1 should survive eviction");
    assert.strictEqual(r1.decision, "mark_engage");

    // e2 (lowest conf) should be gone
    const h2 = store.hash(store.features(e2));
    assert.strictEqual(store.patterns.has(h2), false, "lowest confidence e2 should be evicted");
  });
});

// -- Stats tracking --

describe("stats tracking", () => {
  test("hits and misses tracked accurately", () => {
    const store = makeStore();
    const known = { has_heat: true, vx: 80, vy: 10, y: 640 };
    const unknown = { has_heat: false, vx: 5, vy: 90, y: 100 };

    for (let i = 0; i < 5; i++) store.learn(known, "mark_ignore");

    store.lookup(known);   // hit
    store.lookup(known);   // hit
    store.lookup(unknown); // miss
    store.lookup(unknown); // miss
    store.lookup(unknown); // miss

    const s = store.stats();
    assert.strictEqual(s.hits, 2);
    assert.strictEqual(s.misses, 3);
    assert.strictEqual(s.hitRate, "0.400");
  });

  test("total and confident counts correct", () => {
    const store = makeStore();
    const confident = { has_heat: true, vx: 80, vy: 10, y: 640 };
    const weak = { has_heat: false, vx: 20, vy: 60, y: 300 };

    for (let i = 0; i < 5; i++) store.learn(confident, "mark_ignore");
    store.learn(weak, "mark_engage"); // only 1 learn, below threshold

    const s = store.stats();
    assert.strictEqual(s.total, 2);
    assert.strictEqual(s.confident, 1);
  });
});

// -- Feature extractor --

describe("feature extractor", () => {
  test("fallback extracts primitives when no extractor given", () => {
    const store = new PatternStore({ explorationRate: 0, confidenceThreshold: 0.05, storage: "memory" });
    const entity = { kind: "car", speed: 2.5, active: true, nested: { x: 1 } };

    const feat = store.features(entity);
    assert.strictEqual(feat.kind, "car");
    assert.strictEqual(feat.speed, 2.5);
    assert.strictEqual(feat.active, true);
    assert.strictEqual(feat.nested, undefined); // objects excluded
  });

  test("custom extractor used when provided", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ bucket: e.speed > 5 ? "fast" : "slow" }),
      explorationRate: 0,
      confidenceThreshold: 0.05,
      storage: "memory",
    });

    const feat = store.features({ speed: 10 });
    assert.deepStrictEqual(feat, { bucket: "fast" });
  });
});

// -- Hashing --

describe("hashing", () => {
  test("same features produce same hash regardless of key order", () => {
    const store = makeStore();
    const h1 = store.hash({ a: 1, b: 2, c: 3 });
    const h2 = store.hash({ c: 3, a: 1, b: 2 });
    assert.strictEqual(h1, h2);
  });

  test("different features produce different hashes", () => {
    const store = makeStore();
    const h1 = store.hash({ a: 1, b: 2 });
    const h2 = store.hash({ a: 1, b: 3 });
    assert.notStrictEqual(h1, h2);
  });
});
