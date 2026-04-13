// SCP -- Spatial Context Protocol
// Real-time AI execution runtime for embodied systems.
// "LangGraph helps AI think. SCP helps AI act continuously in the real world."

const { PatternStore } = require("./pattern-store");
const { SCPAdapter } = require("./adapter");
const { SCPBridge } = require("./bridge");

module.exports = { PatternStore, SCPAdapter, SCPBridge };
