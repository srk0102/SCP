const { describe, test } = require("node:test");
const assert = require("node:assert");
const { PatternStore } = require("../pattern-store.js");

// Check if better-sqlite3 is available
let hasSqlite = false;
try {
  require("better-sqlite3");
  hasSqlite = true;
} catch {}

// -- In-memory persistence (save/load round-trip via export/import) --

describe("memory storage", () => {
  test("patterns survive within same instance", () => {
    const store = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,
      confidenceThreshold: 0.05,
      storage: "memory",
    });

    for (let i = 0; i < 3; i++) store.learn({ kind: "car" }, "halt");
    const result = store.lookup({ kind: "car" });
    assert.strictEqual(result.decision, "halt");
  });

  test("save() and load() are no-ops for memory storage", () => {
    const store = new PatternStore({ storage: "memory" });
    // Should not throw
    store.save();
    store.load();
    assert.strictEqual(store.patterns.size, 0);
  });
});

// -- SQLite persistence --

describe("SQLite persistence", { skip: !hasSqlite && "better-sqlite3 not available (no Visual Studio)" }, () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const dbPath = path.join(__dirname, "test-patterns.db");

  function cleanup() {
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + "-wal"); } catch {}
    try { fs.unlinkSync(dbPath + "-shm"); } catch {}
  }

  test("patterns survive process restart", () => {
    cleanup();

    // Session 1: learn patterns
    const store1 = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind, fast: e.speed > 5 }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
      storage: "sqlite",
      storageKey: dbPath,
    });

    for (let i = 0; i < 5; i++) store1.learn({ kind: "ambulance", speed: 8 }, "halt");
    for (let i = 0; i < 5; i++) store1.learn({ kind: "car", speed: 2 }, "mark_ignore");
    store1.save();

    // Session 2: fresh instance, same db
    const store2 = new PatternStore({
      featureExtractor: (e) => ({ kind: e.kind, fast: e.speed > 5 }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
      storage: "sqlite",
      storageKey: dbPath,
    });
    store2.load();

    const r1 = store2.lookup({ kind: "ambulance", speed: 8 });
    assert.strictEqual(r1.decision, "halt");
    assert.strictEqual(r1.source, "exact");

    const r2 = store2.lookup({ kind: "car", speed: 2 });
    assert.strictEqual(r2.decision, "mark_ignore");

    assert.strictEqual(store2.stats().total, 2);

    cleanup();
  });

  test("save overwrites stale data correctly", () => {
    cleanup();

    const opts = {
      featureExtractor: (e) => ({ kind: e.kind }),
      explorationRate: 0,
      confidenceThreshold: 0.05,
      storage: "sqlite",
      storageKey: dbPath,
    };

    // Session 1
    const store1 = new PatternStore(opts);
    store1.learn({ kind: "drone" }, "mark_engage");
    store1.save();

    // Session 2: learn something different for same features
    const store2 = new PatternStore(opts);
    store2.load();
    store2.correct({ kind: "drone" }, "mark_ignore");
    store2.save();

    // Session 3: verify correction persisted
    const store3 = new PatternStore(opts);
    store3.load();
    const result = store3.lookup({ kind: "drone" });
    assert.strictEqual(result.decision, "mark_ignore");

    cleanup();
  });

  test("features stored and recovered for similarity matching", () => {
    cleanup();

    const opts = {
      featureExtractor: (e) => ({
        kind: e.kind,
        speed_bucket: e.speed < 3 ? "slow" : "fast",
      }),
      explorationRate: 0,
      confidenceThreshold: 0.1,
      storage: "sqlite",
      storageKey: dbPath,
    };

    const store1 = new PatternStore(opts);
    for (let i = 0; i < 5; i++) store1.learn({ kind: "car", speed: 1 }, "mark_ignore");
    store1.save();

    // Fresh instance
    const store2 = new PatternStore(opts);
    store2.load();

    // Verify _features were recovered (needed for similarity)
    const entries = [...store2.patterns.values()];
    assert.strictEqual(entries.length, 1);
    assert.deepStrictEqual(entries[0]._features, { kind: "car", speed_bucket: "slow" });

    cleanup();
  });
});
