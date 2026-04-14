const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { AdaptiveMemory, PatternStore, SCPBody } = require("..");

describe("AdaptiveMemory basic", () => {
  test("constructs with defaults", () => {
    const m = new AdaptiveMemory();
    assert.strictEqual(m.threshold, 0.8);
    assert.strictEqual(m.maxHistory, 500);
    assert.strictEqual(m.k, 5);
    assert.strictEqual(m.entries.length, 0);
  });

  test("store adds an entry", () => {
    const m = new AdaptiveMemory();
    const e = m.store({ x: 1, y: 2 }, "decision_a");
    assert.strictEqual(e.id, 1);
    assert.strictEqual(m.entries.length, 1);
    assert.strictEqual(m.stats().entries, 1);
  });

  test("lookup returns null on empty memory", () => {
    const m = new AdaptiveMemory();
    assert.strictEqual(m.lookup({ x: 1 }), null);
    assert.strictEqual(m.stats().misses, 1);
  });

  test("lookup returns best match above threshold", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    m.store({ x: 1, y: 2 }, "A");
    m.store({ x: 10, y: 20 }, "B");
    const r = m.lookup({ x: 1.05, y: 2.02 });
    assert.ok(r);
    assert.strictEqual(r.decision, "A");
    assert.ok(r.confidence > 0);
  });

  test("lookup returns null below threshold", () => {
    const m = new AdaptiveMemory({ threshold: 0.95 });
    m.store({ x: 1 }, "A");
    const r = m.lookup({ x: 100 });
    assert.strictEqual(r, null);
  });
});

describe("AdaptiveMemory similarity scoring", () => {
  test("identical features give similarity 1", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    assert.ok(m._similarity({ a: 1, b: 2 }, { a: 1, b: 2 }) >= 0.999);
  });

  test("completely different numeric features give low similarity", () => {
    const m = new AdaptiveMemory({ threshold: 0 });
    const s = m._similarity({ a: 0 }, { a: 1000 });
    assert.ok(s < 0.2);
  });

  test("weighted features shift priority", () => {
    const m = new AdaptiveMemory({ weights: { critical: 10, noise: 0.1 } });
    // Same critical, different noise -> high similarity.
    const same = m._similarity({ critical: 1, noise: 0 }, { critical: 1, noise: 100 });
    // Different critical, same noise -> low similarity.
    const diff = m._similarity({ critical: 0, noise: 0 }, { critical: 100, noise: 0 });
    assert.ok(same > diff);
  });

  test("missing feature treated as distance", () => {
    const m = new AdaptiveMemory({ threshold: 0 });
    const s = m._similarity({ a: 1, b: 2 }, { a: 1 });
    assert.ok(s < 1);
  });
});

describe("AdaptiveMemory k-nearest", () => {
  test("agreement bumps confidence", () => {
    const m = new AdaptiveMemory({ threshold: 0.5, k: 3 });
    m.store({ x: 1 }, "A");
    m.store({ x: 1.1 }, "A");
    m.store({ x: 1.2 }, "A");
    const r = m.lookup({ x: 1.05 });
    assert.ok(r);
    assert.strictEqual(r.decision, "A");
    assert.ok(r.confidence >= 0.5);
  });

  test("disagreement dilutes confidence", () => {
    const m = new AdaptiveMemory({ threshold: 0.1, k: 3 });
    m.store({ x: 1 }, "A");
    m.store({ x: 1.01 }, "B");
    m.store({ x: 1.02 }, "C");
    const diverse = m.lookup({ x: 1.005 });

    const m2 = new AdaptiveMemory({ threshold: 0.1, k: 3 });
    m2.store({ x: 1 }, "A");
    m2.store({ x: 1.01 }, "A");
    m2.store({ x: 1.02 }, "A");
    const agreed = m2.lookup({ x: 1.005 });

    // With disagreement confidence should drop below full-agreement confidence.
    assert.ok(diverse);
    assert.ok(agreed);
    assert.ok(diverse.confidence < agreed.confidence);
  });
});

describe("AdaptiveMemory outcome reporting", () => {
  test("success increases confidence", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    m.store({ x: 1 }, "A");
    const before = m.entries[0].confidence;
    m.report({ x: 1 }, true);
    assert.ok(m.entries[0].confidence > before);
    assert.strictEqual(m.stats().successReports, 1);
  });

  test("failure decreases confidence", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    m.store({ x: 1 }, "A");
    const before = m.entries[0].confidence;
    m.report({ x: 1 }, false);
    assert.ok(m.entries[0].confidence < before);
    assert.strictEqual(m.stats().failureReports, 1);
  });

  test("consecutive failures purge the entry", () => {
    const m = new AdaptiveMemory({ threshold: 0.5, failureThreshold: 3 });
    m.store({ x: 1 }, "A");
    let purgedEvent = null;
    m.on("entry_purged", (p) => { purgedEvent = p; });
    m.report({ x: 1 }, false);
    m.report({ x: 1 }, false);
    m.report({ x: 1 }, false);
    assert.strictEqual(m.entries.length, 0);
    assert.ok(purgedEvent);
    assert.strictEqual(m.stats().purged, 1);
  });

  test("success resets consecutive failures", () => {
    const m = new AdaptiveMemory({ threshold: 0.5, failureThreshold: 3 });
    m.store({ x: 1 }, "A");
    m.report({ x: 1 }, false);
    m.report({ x: 1 }, false);
    m.report({ x: 1 }, true);
    assert.strictEqual(m.entries[0].consecutiveFailures, 0);
  });
});

describe("AdaptiveMemory eviction", () => {
  test("maxHistory cap evicts worst", () => {
    const m = new AdaptiveMemory({ threshold: 0.5, maxHistory: 3 });
    m.store({ x: 1 }, "A");
    m.store({ x: 2 }, "B");
    m.store({ x: 3 }, "C");
    m.store({ x: 4 }, "D");
    assert.strictEqual(m.entries.length, 3);
  });
});

describe("AdaptiveMemory SQLite persistence", () => {
  function tmpdb(name) {
    return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  }

  test("save and load round-trip", (t) => {
    let hasSqlite = true;
    try { require("better-sqlite3"); } catch { hasSqlite = false; }
    if (!hasSqlite) { t.skip("better-sqlite3 not installed"); return; }

    const file = tmpdb("adapt-rt");
    try {
      const m = new AdaptiveMemory({ storage: "sqlite", storageKey: file, threshold: 0.5 });
      m.store({ x: 1 }, "A");
      m.store({ x: 2 }, "B");
      m.save();

      const m2 = new AdaptiveMemory({ storage: "sqlite", storageKey: file, threshold: 0.5 });
      const n = m2.load();
      assert.strictEqual(n, 2);
      assert.strictEqual(m2.entries.length, 2);
    } finally {
      try { fs.unlinkSync(file); fs.unlinkSync(file + "-shm"); fs.unlinkSync(file + "-wal"); } catch {}
    }
  });
});

describe("AdaptiveMemory integration with SCPBody", () => {
  test("decideLocally consults adaptive memory when pattern store misses", () => {
    class Bot extends SCPBody {
      static bodyName = "bot";
      static tools = { go: { description: "go", parameters: {} } };
      async go() { return { ok: true }; }
    }
    const pattern = new PatternStore({ featureExtractor: (e) => ({ kind: e.kind }) });
    const mem = new AdaptiveMemory({ threshold: 0.5 });
    const b = new Bot({ patternStore: pattern, adaptiveMemory: mem });

    // Pattern store is empty, but adaptive memory has a generalization.
    mem.store({ kind: "enemy" }, "halt");

    const hit = b.decideLocally({ kind: "enemy" });
    assert.ok(hit, "expected adaptive memory hit");
    assert.strictEqual(hit.decision, "halt");
    assert.strictEqual(hit.source, "adaptive");
  });

  test("learnFromBrain populates both stores", () => {
    class Bot extends SCPBody {
      static bodyName = "bot";
      static tools = { go: { description: "go", parameters: {} } };
      async go() { return { ok: true }; }
    }
    const pattern = new PatternStore({ featureExtractor: (e) => ({ kind: e.kind }) });
    const mem = new AdaptiveMemory({ threshold: 0.5 });
    const b = new Bot({ patternStore: pattern, adaptiveMemory: mem });

    b.learnFromBrain({ kind: "ally" }, "advance");
    assert.strictEqual(pattern.patterns.size, 1);
    assert.strictEqual(mem.entries.length, 1);
  });

  test("pattern store checked before adaptive memory", () => {
    class Bot extends SCPBody {
      static bodyName = "bot";
      static tools = { go: { description: "go", parameters: {} } };
      async go() { return { ok: true }; }
    }
    const pattern = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,  // deterministic for this test
    });
    const mem = new AdaptiveMemory({ threshold: 0.5 });
    const b = new Bot({ patternStore: pattern, adaptiveMemory: mem });

    for (let i = 0; i < 20; i++) pattern.learn({ kind: "ally" }, "shake_hands");
    mem.store({ kind: "ally" }, "advance");

    const hit = b.decideLocally({ kind: "ally" });
    assert.ok(hit);
    // Pattern source wins because it is layer 2.
    assert.notStrictEqual(hit.source, "adaptive");
  });
});

describe("AdaptiveMemory stats", () => {
  test("stats reflect activity", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    m.store({ x: 1 }, "A");
    m.lookup({ x: 1 });          // hit
    m.lookup({ x: 999 });         // miss
    m.report({ x: 1 }, true);
    const s = m.stats();
    assert.strictEqual(s.entries, 1);
    assert.strictEqual(s.hits, 1);
    assert.strictEqual(s.misses, 1);
    assert.strictEqual(s.successReports, 1);
    assert.ok(s.avgConfidence > 0);
    assert.ok(s.hitRate > 0);
  });

  test("hitRate is zero before any activity", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    assert.strictEqual(m.stats().hitRate, 0);
    assert.strictEqual(m.stats().avgConfidence, 0);
  });

  test("avgConfidence averages across entries", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    m.store({ x: 1 }, "A");
    m.store({ x: 2 }, "B");
    const s = m.stats();
    assert.ok(s.avgConfidence > 0);
    assert.strictEqual(s.entries, 2);
  });
});

describe("AdaptiveMemory edge cases", () => {
  test("store throws on invalid features", () => {
    const m = new AdaptiveMemory();
    assert.throws(() => m.store(null, "x"), /features must be an object/);
    assert.throws(() => m.store("string", "x"), /features must be an object/);
  });

  test("lookup handles non-object features", () => {
    const m = new AdaptiveMemory();
    m.store({ x: 1 }, "A");
    assert.strictEqual(m.lookup(null), null);
    assert.strictEqual(m.lookup(42), null);
  });

  test("duplicate store reinforces existing entry", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    const a = m.store({ x: 1 }, "A");
    const before = a.confidence;
    const b = m.store({ x: 1 }, "A");
    assert.strictEqual(a, b);
    assert.ok(b.confidence >= before);
    assert.strictEqual(m.entries.length, 1);
  });

  test("report with no match returns {found: false}", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    const r = m.report({ x: 1 }, true);
    assert.deepStrictEqual(r, { found: false });
  });

  test("entry_purged event carries features", () => {
    const m = new AdaptiveMemory({ threshold: 0.5, failureThreshold: 2 });
    m.store({ a: 1, b: 2 }, "X");
    let seenFeatures = null;
    m.on("entry_purged", (p) => { seenFeatures = p.features; });
    m.report({ a: 1, b: 2 }, false);
    m.report({ a: 1, b: 2 }, false);
    assert.deepStrictEqual(seenFeatures, { a: 1, b: 2 });
  });

  test("Brain.costForModel-equivalent exposure not needed here; module unaffected", () => {
    // Sanity: AdaptiveMemory does not leak Brain imports or cost knobs.
    const mod = require("..");
    assert.ok("AdaptiveMemory" in mod);
    assert.ok("PatternStore" in mod);
  });

  test("weights default to 1 when not given", () => {
    const m = new AdaptiveMemory({ threshold: 0.5 });
    m.store({ a: 0 }, "A");
    m.store({ a: 10 }, "B");
    const exact = m.lookup({ a: 0 });
    assert.ok(exact);
    assert.strictEqual(exact.decision, "A");
  });
});
