const { describe, test } = require("node:test");
const assert = require("node:assert");
const { BedrockBridge } = require("../bridges/bedrock");
const { OllamaBridge } = require("../bridges/ollama");
const { OpenAIBridge } = require("../bridges/openai");

// These tests verify the bridge interfaces work correctly.
// They do NOT make real API calls (no credentials needed).

describe("BedrockBridge", () => {
  test("constructor sets defaults", () => {
    const b = new BedrockBridge();
    assert.strictEqual(b.model, "amazon.nova-micro-v1:0");
    assert.strictEqual(b.region, "us-east-1");
    assert.strictEqual(b.maxTokens, 512);
    assert.strictEqual(b.temperature, 0.1);
  });

  test("constructor accepts overrides", () => {
    const b = new BedrockBridge({
      model: "anthropic.claude-3-haiku",
      region: "us-west-2",
      maxTokens: 256,
      temperature: 0.5,
      systemPrompt: "You are a robot brain.",
    });
    assert.strictEqual(b.model, "anthropic.claude-3-haiku");
    assert.strictEqual(b.region, "us-west-2");
    assert.strictEqual(b.maxTokens, 256);
    assert.strictEqual(b.temperature, 0.5);
    assert.strictEqual(b.systemPrompt, "You are a robot brain.");
  });

  test("call() fails gracefully without AWS SDK installed", async () => {
    const b = new BedrockBridge();
    // Will throw because @aws-sdk/client-bedrock-runtime is not installed in test env
    await assert.rejects(() => b.call({ test: true }), (err) => {
      return err.code === "MODULE_NOT_FOUND" || err.message.includes("Cannot find module");
    });
  });
});

describe("OllamaBridge", () => {
  test("constructor sets defaults", () => {
    const b = new OllamaBridge();
    assert.strictEqual(b.model, "llama3.2");
    assert.strictEqual(b.host, "http://localhost:11434");
  });

  test("constructor accepts overrides", () => {
    const b = new OllamaBridge({
      model: "mistral",
      host: "http://192.168.1.100:11434",
      systemPrompt: "Classify entities.",
    });
    assert.strictEqual(b.model, "mistral");
    assert.strictEqual(b.host, "http://192.168.1.100:11434");
    assert.strictEqual(b.systemPrompt, "Classify entities.");
  });

  test("call() fails gracefully when Ollama not running", async () => {
    const b = new OllamaBridge({ host: "http://localhost:19999" }); // wrong port
    await assert.rejects(() => b.call({ test: true }), (err) => {
      return err.code === "ECONNREFUSED" || err.message.includes("ECONNREFUSED");
    });
  });
});

describe("OpenAIBridge", () => {
  test("constructor sets defaults", () => {
    const b = new OpenAIBridge();
    assert.strictEqual(b.model, "gpt-4o-mini");
  });

  test("constructor accepts overrides", () => {
    const b = new OpenAIBridge({
      model: "gpt-4o",
      apiKey: "sk-test-key",
    });
    assert.strictEqual(b.model, "gpt-4o");
    assert.strictEqual(b.apiKey, "sk-test-key");
  });

  test("call() throws without API key", async () => {
    const saved = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const b = new OpenAIBridge({ apiKey: undefined });
    await assert.rejects(() => b.call({ test: true }), {
      message: /no API key/,
    });
    if (saved) process.env.OPENAI_API_KEY = saved;
  });
});

describe("bridge interface consistency", () => {
  test("all bridges extend SCPBridge with same interface", () => {
    const bridges = [new BedrockBridge(), new OllamaBridge(), new OpenAIBridge()];
    for (const b of bridges) {
      assert.strictEqual(typeof b.call, "function");
      assert.strictEqual(typeof b.invoke, "function");
      assert.strictEqual(typeof b.stats, "function");
      assert.strictEqual(typeof b.model, "string");
      assert.strictEqual(typeof b.maxTokens, "number");
      assert.strictEqual(typeof b.temperature, "number");
    }
  });
});
