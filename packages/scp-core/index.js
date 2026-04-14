// SCP -- Spatial Context Protocol
// Real-time AI execution runtime for embodied systems.
// "LangGraph helps AI think. SCP helps AI act continuously in the real world."

const { PatternStore } = require("./pattern-store");
const { AdaptiveMemory } = require("./adaptive-memory");
const { SCPAdapter } = require("./adapter");
const { SCPBody, PRIORITY } = require("./body");
const { SCPBridge } = require("./bridge");

// Bridges
const { BedrockBridge } = require("./bridges/bedrock");
const { OllamaBridge } = require("./bridges/ollama");
const { OpenAIBridge } = require("./bridges/openai");

// Transports (kept for explicit network bodies and v0.1 back-compat)
const { SCPTransport } = require("./transports/base");
const { WebSocketTransport } = require("./transports/websocket");
const { HTTPTransport } = require("./transports/http");

module.exports = {
  // Core
  PatternStore,
  AdaptiveMemory,
  SCPBody,        // v0.2 -- pure class, default inprocess
  SCPAdapter,     // v0.1 legacy, kept for back-compat
  SCPBridge,
  PRIORITY,

  // Bridges
  BedrockBridge,
  OllamaBridge,
  OpenAIBridge,

  // Transports (explicit opt-in)
  SCPTransport,
  WebSocketTransport,
  HTTPTransport,
};
