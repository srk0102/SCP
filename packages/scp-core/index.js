// SCP -- Spatial Context Protocol
// Real-time AI execution runtime for embodied systems.
// "LangGraph helps AI think. SCP helps AI act continuously in the real world."

const { PatternStore } = require("./pattern-store");
const { SCPAdapter } = require("./adapter");
const { SCPBridge } = require("./bridge");

// Bridges
const { BedrockBridge } = require("./bridges/bedrock");
const { OllamaBridge } = require("./bridges/ollama");
const { OpenAIBridge } = require("./bridges/openai");

// Transports
const { SCPTransport } = require("./transports/base");
const { WebSocketTransport } = require("./transports/websocket");
const { HTTPTransport } = require("./transports/http");

module.exports = {
  // Core
  PatternStore,
  SCPAdapter,
  SCPBridge,

  // Bridges
  BedrockBridge,
  OllamaBridge,
  OpenAIBridge,

  // Transports
  SCPTransport,
  WebSocketTransport,
  HTTPTransport,
};
