// SCP MCP Server
// Exposes SCP primitives as MCP tools over stdio. The brain (Qwen, Claude,
// GPT, anything) calls these tools — the server routes them to the muscle
// via the WebSocket bridge. Brain never sees the 60fps physics, only
// semantic events when something matters.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { store, SCP_VERSION } from "./world-store.js";
import { startWsBridge } from "./ws-bridge.js";

// Boot the WS bridge in the same process so the muscle and the MCP server
// share one in-memory store. No IPC, no race conditions.
startWsBridge();

const TOOLS = [
  {
    name: "list_embodiments",
    description: "List all currently connected embodiments (bodies). Returns their IDs and specs so the brain knows what it can control.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "query_world_state",
    description: "Read the current task-space snapshot of the world for a given embodiment. Returns actuator positions, entities (targets), and current assignments. Use this to plan — never to execute.",
    inputSchema: {
      type: "object",
      properties: {
        embodiment_id: { type: "string" },
      },
      required: ["embodiment_id"],
      additionalProperties: false,
    },
  },
  {
    name: "assign_targets",
    description: "Dispatch a bulk assignment of intents to actuators. ONE round-trip allocates all hands. The muscle executes at native frame rate. NEVER use this to control hands per-frame — use it to allocate at 1Hz or when events fire. Intent types are TASK-SPACE primitives only — never joint angles. After calling query_world_state, you MUST call this to act on what you saw.",
    inputSchema: {
      type: "object",
      properties: {
        embodiment_id: { type: "string" },
        assignments: {
          type: "array",
          description: "One Intent per actuator. Mix-and-match types as needed: mark_engage for cold targets the heat sensor cannot see (e.g. stealth missiles), mark_ignore to veto a hot target the heat sensor would otherwise shoot (e.g. friendly aircraft), engage_target for general assignment, halt to release.",
          items: {
            type: "object",
            properties: {
              actuator_id: { type: "string", description: "Hand to apply the intent to" },
              type: {
                type: "string",
                enum: ["mark_engage", "mark_ignore", "engage_target", "translate_to", "halt"],
                description: "mark_engage = chase a cold target the heat sensor cannot see; mark_ignore = veto a hot target so the heat sensor skips it; engage_target = generic assignment; halt = release"
              },
              target_entity_id: { type: "string", description: "Which entity in world_state.entities the intent applies to" },
              target_position: { type: "array", items: { type: "number" }, description: "Optional [x, y] for translate_to intents only" },
              urgency: { type: "string", enum: ["low", "normal", "high"] },
            },
            required: ["actuator_id", "type"],
          },
        },
        rationale: { type: "string", description: "Optional one-sentence reasoning trace for logging — keep brief" },
      },
      required: ["embodiment_id", "assignments"],
      additionalProperties: false,
    },
  },
  {
    name: "poll_events",
    description: "Pull accumulated semantic events for an embodiment. Drains the queue. Call this after assign_targets to learn what happened (hits, failures, collisions). The muscle only fires events on threshold breaks — you will not be flooded.",
    inputSchema: {
      type: "object",
      properties: {
        embodiment_id: { type: "string" },
      },
      required: ["embodiment_id"],
      additionalProperties: false,
    },
  },
];

const server = new Server(
  { name: "scp-server", version: SCP_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "list_embodiments") {
    const embs = store.listEmbodiments();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          embodiments: embs.map(e => ({
            embodiment_id: e.embodiment_id,
            label: e.label,
            dimensions: e.dimensions,
            actuator_count: (e.actuators || []).length,
            workspace: e.workspace,
          })),
        }),
      }],
    };
  }

  if (name === "query_world_state") {
    const w = store.getWorldState(args.embodiment_id);
    if (!w) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "no world state for embodiment", embodiment_id: args.embodiment_id }) }] };
    }
    // Include muscle's current mode so the bridge can skip wakes in no-brainer
    const mode = store.getMuscleMode(args.embodiment_id);
    return { content: [{ type: "text", text: JSON.stringify({ ...w, muscle_mode: mode }) }] };
  }

  if (name === "assign_targets") {
    const assignment = {
      assignment_id: `as_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      scp_version: SCP_VERSION,
      assignments: (args.assignments || []).map(a => ({
        intent_id: `int_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        scp_version: SCP_VERSION,
        ...a,
      })),
      rationale: args.rationale || "",
    };
    const ok = store.enqueueAssignment(args.embodiment_id, assignment);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ accepted: ok, assignment_id: assignment.assignment_id, dispatched: assignment.assignments.length }),
      }],
    };
  }

  if (name === "poll_events") {
    const events = store.drainEvents(args.embodiment_id);
    return { content: [{ type: "text", text: JSON.stringify({ events }) }] };
  }

  return { content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[scp-mcp] stdio MCP server ready");
