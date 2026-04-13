// SCP Bridge — MCP client that wakes an LLM on semantic events
// =============================================================
// Uses AWS Bedrock Claude Haiku for tool calls (replaces local Qwen shim).
// The bridge prefetches world state itself and injects it into the user
// message — the LLM sees only ONE tool (assign_targets) and must call it.
// No chaining. No query_world_state from the model side. One call per wake.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Config ----------
const MODEL_ID = process.env.MODEL_ID || "amazon.nova-micro-v1:0";
const AWS_REGION = process.env.AWS_REGION || process.env.S3_AWS_REGION || "us-east-1";
const POLL_MS = parseInt(process.env.POLL_MS || "300", 10);
const HISTORY_CAP = parseInt(process.env.HISTORY_CAP || "10", 10);
const PROMPT_PATH = process.env.PROMPT_PATH || path.join(__dirname, "system-prompt.md");
const SYSTEM_PROMPT = readFileSync(PROMPT_PATH, "utf8");

// Load .env if present (for AWS creds)
try {
  const envPath = path.resolve(__dirname, "..", ".env");
  const envText = readFileSync(envPath, "utf8");
  for (const line of envText.split("\n")) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) process.env[m[1]] = m[2].trim();
  }
} catch {}

// Map S3_AWS_* to standard AWS SDK env vars if not already set
if (!process.env.AWS_ACCESS_KEY_ID && process.env.S3_AWS_ACCESS_KEY_ID) {
  process.env.AWS_ACCESS_KEY_ID = process.env.S3_AWS_ACCESS_KEY_ID;
}
if (!process.env.AWS_SECRET_ACCESS_KEY && process.env.S3_AWS_SECRET_ACCESS_KEY) {
  process.env.AWS_SECRET_ACCESS_KEY = process.env.S3_AWS_SECRET_ACCESS_KEY;
}

const bedrock = new BedrockRuntimeClient({ region: AWS_REGION });

// Wake triggers (semantic events from muscle that should invoke the brain)
const WAKE_TRIGGERS = new Set([
  "reallocation_requested",
  "intent_failed",
  "actuator_blocked",
  "force_threshold_exceeded",
]);
const RADAR_CONTACT_CAUSE = "radar_contact";
const SOFT_TRIGGERS = new Set(["target_engaged"]);
const SOFT_THRESHOLD = 4;
const EVENT_PAYLOAD_CAP = 8;

// ---------- MCP client over stdio ----------
class McpStdioClient {
  constructor(cmd, args, cwd) {
    this.proc = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "inherit"] });
    this.id = 0;
    this.pending = new Map();
    this.buffer = "";
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.on("exit", (code) => console.error(`[mcp] server exited ${code}`));
  }
  _onData(chunk) {
    this.buffer += chunk.toString();
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    }
  }
  request(method, params) {
    const id = ++this.id;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(payload);
    });
  }
  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "scp-bridge", version: "0.1.0" },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }
  async listTools() {
    const r = await this.request("tools/list", {});
    return r.tools;
  }
  async callTool(name, args) {
    const r = await this.request("tools/call", { name, arguments: args });
    const text = r?.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return text; }
  }
}

// ---------- Bedrock Converse API ----------
// The assign_targets tool spec — the ONLY tool the LLM sees.
const ASSIGN_TOOL = {
  toolSpec: {
    name: "assign_targets",
    description: "Dispatch mark_engage for cold missiles and mark_ignore for planes. One call per wake. World state is in your user message.",
    inputSchema: {
      json: {
        type: "object",
        properties: {
          embodiment_id: { type: "string" },
          assignments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                actuator_id: { type: "string" },
                type: { type: "string", enum: ["mark_engage", "mark_ignore", "halt"] },
                target_entity_id: { type: "string" },
              },
              required: ["actuator_id", "type"],
            },
          },
          rationale: { type: "string" },
        },
        required: ["embodiment_id", "assignments"],
      },
    },
  },
};

async function callBedrock(messages) {
  const cmd = new ConverseCommand({
    modelId: MODEL_ID,
    system: [{ text: SYSTEM_PROMPT }],
    messages,
    toolConfig: { tools: [ASSIGN_TOOL] },
    inferenceConfig: { maxTokens: 512, temperature: 0.1 },
  });
  const resp = await bedrock.send(cmd);
  return resp;
}

// ---------- main ----------
async function main() {
  console.error(`[bridge] starting MCP server (model=${MODEL_ID}, region=${AWS_REGION}, poll=${POLL_MS}ms)`);
  const mcp = new McpStdioClient("node", [path.resolve(__dirname, "..", "server", "mcp-server.js")]);

  await new Promise(r => setTimeout(r, 800));
  await mcp.initialize();
  const tools = await mcp.listTools();
  console.error(`[bridge] discovered ${tools.length} MCP tools: ${tools.map(t => t.name).join(", ")}`);

  let embodiment_id = null;
  while (!embodiment_id) {
    const list = await mcp.callTool("list_embodiments", {});
    if (list.embodiments && list.embodiments.length) {
      embodiment_id = list.embodiments[0].embodiment_id;
      console.error(`[bridge] bound to embodiment ${embodiment_id}`);
    } else {
      console.error("[bridge] waiting for muscle to connect to ws://localhost:7777 ...");
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // ---------- SCP event-driven loop ----------
  let softCount = 0;
  let wakeCount = 0;
  const conversationHistory = [];

  while (true) {
    try {
      const polled = await mcp.callTool("poll_events", { embodiment_id });
      const events = polled.events || [];
      if (events.length > 0) console.error(`[bridge] polled ${events.length} events: ${events.map(e=>e.type).join(",")}`);


      let shouldWake = false;
      let wakeReason = "";
      const limbReports = [];

      for (const e of events) {
        if (WAKE_TRIGGERS.has(e.type)) {
          shouldWake = true;
          if (!wakeReason) wakeReason = `${e.type}${e.cause ? `:${e.cause}` : ""}`;
          if (e.actuator_id && e.entity_id) {
            limbReports.push(`${e.actuator_id}: ${e.entity_id} (${e.cause || e.type})`);
          }
        }
        if (e.type === "world_state_changed" && e.cause === RADAR_CONTACT_CAUSE) {
          shouldWake = true;
          if (!wakeReason) wakeReason = "radar_contact";
        }
        if (SOFT_TRIGGERS.has(e.type)) softCount++;
      }
      if (!shouldWake && softCount >= SOFT_THRESHOLD) {
        shouldWake = true;
        wakeReason = `soft_trigger(${softCount})`;
        softCount = 0;
      }

      if (shouldWake) {
        wakeCount++;
        softCount = 0;

        // PREFETCH world state — the brain doesn't call query_world_state itself
        const worldState = await mcp.callTool("query_world_state", { embodiment_id });
        const muscleMode = worldState?.muscle_mode || "scp";

        // Bug fix: skip all LLM calls in no-brainer mode — muscle handles everything locally
        if (muscleMode === "no-brainer") {
          continue;
        }

        const entityCount = worldState?.entities?.length || 0;

        if (entityCount === 0) {
          // Nothing to classify — skip this wake
          continue;
        }

        const limbSummary = limbReports.slice(-EVENT_PAYLOAD_CAP).join("; ");
        const userMsg = `Wake: ${wakeReason}. ${limbSummary ? `Limb reports: ${limbSummary}. ` : ""}` +
          `World state (${entityCount} entities):\n${JSON.stringify(worldState, null, 0)}\n\n` +
          `Call assign_targets now. For missile_stealth → mark_engage nearest hand. For plane → mark_ignore nearby hands. For bird → skip.`;

        conversationHistory.push({ role: "user", content: [{ text: userMsg }] });

        console.error(`[scp wake ${wakeCount}] reason=${wakeReason} entities=${entityCount} limbReports=${limbReports.length}`);

        try {
          const resp = await callBedrock(conversationHistory);
          const output = resp.output?.message;

          if (output) {
            conversationHistory.push(output);

            // Check if the model made a tool call
            const toolUseBlock = output.content?.find(b => b.toolUse);
            if (toolUseBlock) {
              const tu = toolUseBlock.toolUse;
              console.error(`[scp wake ${wakeCount}] ✓ ${tu.name}: ${JSON.stringify(tu.input).slice(0, 300)}`);

              // Route the tool call through MCP
              let result;
              try {
                result = await mcp.callTool(tu.name, tu.input);
              } catch (e) {
                result = { error: String(e) };
              }

              // Send tool result back to complete the conversation
              conversationHistory.push({
                role: "user",
                content: [{ toolResult: { toolUseId: tu.toolUseId, content: [{ text: JSON.stringify(result) }] } }],
              });
            } else {
              const textBlock = output.content?.find(b => b.text);
              console.error(`[scp wake ${wakeCount}] ⚠ NO tool call. Text: ${(textBlock?.text || "").slice(0, 150)}`);
            }
          }
        } catch (e) {
          console.error(`[scp wake ${wakeCount}] bedrock error: ${e.message}`);
        }

        // Trim conversation history
        while (conversationHistory.length > HISTORY_CAP) conversationHistory.shift();
      }
    } catch (e) {
      console.error(`[scp loop] error:`, e.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => { console.error("[bridge] fatal:", e); process.exit(1); });
