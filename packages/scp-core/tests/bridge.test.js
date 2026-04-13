const { describe, test } = require("node:test");
const assert = require("node:assert");
const { SCPBridge } = require("../bridge.js");

// -- Subclass requirement --

describe("SCPBridge base class", () => {
  test("call() throws if not implemented", async () => {
    const bridge = new SCPBridge();
    await assert.rejects(() => bridge.call("test", []), {
      message: "SCPBridge.call() must be implemented by subclass",
    });
  });

  test("invoke() throws if call() not implemented", async () => {
    const bridge = new SCPBridge();
    await assert.rejects(() => bridge.invoke("test", []), {
      message: "SCPBridge.call() must be implemented by subclass",
    });
  });
});

// -- Timing --

describe("bridge timing", () => {
  test("records call duration on success", async () => {
    class SlowBridge extends SCPBridge {
      async call() {
        await new Promise(r => setTimeout(r, 50));
        return { decision: "mark_engage" };
      }
    }

    const bridge = new SlowBridge();
    await bridge.invoke("test");

    assert.ok(bridge.lastCallMs >= 40, `expected >= 40ms, got ${bridge.lastCallMs}ms`);
    assert.ok(bridge.lastCallMs < 200, `expected < 200ms, got ${bridge.lastCallMs}ms`);
  });

  test("records call duration on failure", async () => {
    class FailBridge extends SCPBridge {
      async call() {
        await new Promise(r => setTimeout(r, 30));
        throw new Error("connection timeout");
      }
    }

    const bridge = new FailBridge();
    try { await bridge.invoke("test"); } catch {}

    assert.ok(bridge.lastCallMs >= 20, `expected >= 20ms, got ${bridge.lastCallMs}ms`);
  });
});

// -- Stats --

describe("bridge stats", () => {
  test("callCount increments on success", async () => {
    class OkBridge extends SCPBridge {
      async call() { return { decision: "ok" }; }
    }

    const bridge = new OkBridge();
    await bridge.invoke("a");
    await bridge.invoke("b");
    await bridge.invoke("c");

    assert.strictEqual(bridge.stats().calls, 3);
    assert.strictEqual(bridge.stats().errors, 0);
  });

  test("errorCount increments on failure", async () => {
    class BadBridge extends SCPBridge {
      async call() { throw new Error("fail"); }
    }

    const bridge = new BadBridge();
    try { await bridge.invoke("a"); } catch {}
    try { await bridge.invoke("b"); } catch {}

    assert.strictEqual(bridge.stats().errors, 2);
    assert.strictEqual(bridge.stats().calls, 0);
  });

  test("mixed success and failure tracked separately", async () => {
    let shouldFail = false;

    class MixedBridge extends SCPBridge {
      async call() {
        if (shouldFail) throw new Error("fail");
        return { decision: "ok" };
      }
    }

    const bridge = new MixedBridge();
    await bridge.invoke("ok1");
    await bridge.invoke("ok2");
    shouldFail = true;
    try { await bridge.invoke("fail1"); } catch {}
    shouldFail = false;
    await bridge.invoke("ok3");

    const s = bridge.stats();
    assert.strictEqual(s.calls, 3);
    assert.strictEqual(s.errors, 1);
  });
});

// -- Constructor options --

describe("bridge constructor", () => {
  test("accepts model, maxTokens, temperature, systemPrompt", () => {
    const bridge = new SCPBridge({
      model: "nova-micro",
      maxTokens: 256,
      temperature: 0.3,
      systemPrompt: "You are a missile defense brain.",
    });

    assert.strictEqual(bridge.model, "nova-micro");
    assert.strictEqual(bridge.maxTokens, 256);
    assert.strictEqual(bridge.temperature, 0.3);
    assert.strictEqual(bridge.systemPrompt, "You are a missile defense brain.");
  });

  test("defaults are sane", () => {
    const bridge = new SCPBridge();
    assert.strictEqual(bridge.model, null);
    assert.strictEqual(bridge.maxTokens, 512);
    assert.strictEqual(bridge.temperature, 0.1);
    assert.strictEqual(bridge.systemPrompt, "");
    assert.strictEqual(bridge.callCount, 0);
    assert.strictEqual(bridge.errorCount, 0);
  });

  test("temperature 0 is valid, not overridden by default", () => {
    const bridge = new SCPBridge({ temperature: 0 });
    assert.strictEqual(bridge.temperature, 0);
  });
});
