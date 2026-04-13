const { describe, test, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { SCPTransport } = require("../transports/base");
const { HTTPTransport } = require("../transports/http");

describe("SCPTransport base class", () => {
  test("emit() throws if not implemented", () => {
    const t = new SCPTransport();
    assert.throws(() => t.emit("test", {}), {
      message: /must be implemented/,
    });
  });

  test("start() throws if not implemented", async () => {
    const t = new SCPTransport();
    await assert.rejects(() => t.start(), {
      message: /must be implemented/,
    });
  });

  test("on() registers handlers", () => {
    const t = new SCPTransport();
    let called = false;
    t.on("test", () => { called = true; });
    t._dispatch("test", {});
    assert.strictEqual(called, true);
  });
});

describe("HTTPTransport", () => {
  let transport;
  const PORT = 18234; // unlikely to conflict

  after(async () => {
    if (transport) await transport.stop();
  });

  test("starts and serves /health", async () => {
    transport = new HTTPTransport({ port: PORT });
    await transport.start();

    const res = await fetch(`http://localhost:${PORT}/health`);
    const data = await res.json();
    assert.strictEqual(data.status, "ok");
    assert.strictEqual(data.port, PORT);
  });

  test("POST /emit dispatches to handler", async () => {
    let received = null;
    transport.on("test_event", (msg) => { received = msg; });

    await fetch(`http://localhost:${PORT}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "test_event", value: 42 }),
    });

    assert.notStrictEqual(received, null);
    assert.strictEqual(received.type, "test_event");
    assert.strictEqual(received.value, 42);
  });

  test("emit() queues messages for GET /poll", async () => {
    transport.emit("brain_response", { decision: "mark_engage", entity: "drone_5" });
    transport.emit("brain_response", { decision: "mark_ignore", entity: "bird_2" });

    const res = await fetch(`http://localhost:${PORT}/poll`);
    const data = await res.json();

    assert.strictEqual(data.messages.length, 2);
    assert.strictEqual(data.messages[0].decision, "mark_engage");
    assert.strictEqual(data.messages[1].decision, "mark_ignore");
  });

  test("GET /poll returns empty after drain", async () => {
    const res = await fetch(`http://localhost:${PORT}/poll`);
    const data = await res.json();
    assert.strictEqual(data.messages.length, 0);
  });

  test("POST /emit with bad JSON returns 400", async () => {
    const res = await fetch(`http://localhost:${PORT}/emit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    assert.strictEqual(res.status, 400);
  });

  test("unknown route returns 404", async () => {
    const res = await fetch(`http://localhost:${PORT}/nope`);
    assert.strictEqual(res.status, 404);
  });

  test("stop() shuts down cleanly", async () => {
    await transport.stop();
    transport = null;

    // Port should be free
    await assert.rejects(
      () => fetch(`http://localhost:${PORT}/health`),
      (err) => err.cause?.code === "ECONNREFUSED" || err.message.includes("fetch failed")
    );
  });
});
