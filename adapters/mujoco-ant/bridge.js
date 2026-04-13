// SCP Bridge for MuJoCo Ant
// Runs HTTPTransport on port 3000.
// Receives semantic events from Python muscle.
// Calls Ollama (free, local) for brain decisions.
// Sends decisions back via /poll endpoint.
//
// Run: node bridge.js
// Requires: ollama running with a model pulled (ollama pull llama3.2)

const path = require("node:path");
const fs = require("node:fs");
const { HTTPTransport } = require("../../packages/scp-core/transports/http");
const { OllamaBridge } = require("../../packages/scp-core/bridges/ollama");
const { PatternStore } = require("../../packages/scp-core/pattern-store");

// Config
const PORT = parseInt(process.env.SCP_PORT || "3000", 10);
const MODEL = process.env.OLLAMA_MODEL || "llama3.2";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
const PROMPT_PATH = path.join(__dirname, "system-prompt.md");
const SYSTEM_PROMPT = fs.readFileSync(PROMPT_PATH, "utf8");

// Valid actions the brain can return
const VALID_ACTIONS = new Set([
  "walk_forward", "speed_up", "turn_left", "turn_right", "stabilize", "reset"
]);

async function main() {
  // Start HTTP transport
  const transport = new HTTPTransport({ port: PORT });
  await transport.start();

  // Set up Ollama bridge
  const bridge = new OllamaBridge({
    model: MODEL,
    host: OLLAMA_HOST,
    systemPrompt: SYSTEM_PROMPT,
    temperature: 0.1,
    maxTokens: 50,
  });

  // Server-side pattern store (mirrors the Python one)
  const store = new PatternStore({
    featureExtractor: (state) => ({
      situation: state.situation || "unknown",
      is_upright: state.height > 0.3,
      speed_bucket: Math.abs(state.forward_vel) > 1 ? "fast" : Math.abs(state.forward_vel) < 0.3 ? "slow" : "medium",
    }),
    confidenceThreshold: 0.15,
    explorationRate: 0,  // no exploration on bridge side, Python handles it
    storage: "memory",
  });

  let brainCalls = 0;
  let cacheHits = 0;

  // Handle incoming events from Python muscle
  transport.on("situation_falling", (msg) => handleEvent(msg, "falling"));
  transport.on("situation_stuck", (msg) => handleEvent(msg, "stuck"));
  transport.on("situation_tilted", (msg) => handleEvent(msg, "tilted"));
  transport.on("situation_moving_fast", (msg) => handleEvent(msg, "moving_fast"));
  transport.on("situation_moving_normal", (msg) => handleEvent(msg, "moving_normal"));

  async function handleEvent(msg, situation) {
    const state = msg.state || {};
    state.situation = situation;

    // Check bridge-side cache first
    const cached = store.lookup(state);
    if (cached) {
      cacheHits++;
      transport.emit("brain_response", { decision: cached.decision });
      return;
    }

    // Call Ollama
    try {
      const result = await bridge.invoke({
        situation,
        height: state.height,
        forward_vel: state.forward_vel,
        roll: state.roll,
        pitch: state.pitch,
        contact_count: state.contact_count,
      });

      brainCalls++;

      // Parse decision from LLM response
      let decision = "walk_forward"; // default
      const raw = typeof result.decision === "string" ? result.decision.trim().toLowerCase() : "";

      for (const action of VALID_ACTIONS) {
        if (raw.includes(action)) {
          decision = action;
          break;
        }
      }

      // Learn
      store.learn(state, decision);

      // Send decision back to Python
      transport.emit("brain_response", { decision });

      console.log(`  [brain] ${situation} -> ${decision} (call #${brainCalls})`);
    } catch (e) {
      // Ollama not running or error -- use default
      const defaults = {
        falling: "stabilize",
        stuck: "turn_left",
        tilted: "stabilize",
        moving_fast: "walk_forward",
        moving_normal: "speed_up",
      };
      const decision = defaults[situation] || "walk_forward";
      store.learn(state, decision);
      transport.emit("brain_response", { decision });
    }
  }

  // Stats reporting
  setInterval(() => {
    const s = store.stats();
    console.log(`  [bridge] brain=${brainCalls} cache=${cacheHits} patterns=${s.total} confident=${s.confident}`);
  }, 5000);

  console.log(`[SCP MuJoCo Bridge] Running on port ${PORT}`);
  console.log(`[SCP MuJoCo Bridge] Ollama: ${OLLAMA_HOST} model=${MODEL}`);
  console.log(`[SCP MuJoCo Bridge] Waiting for muscle events...\n`);
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
