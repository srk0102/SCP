// WebSocket bridge: 60Hz pipe between the browser muscle and the SCP server.
// Listens on :7777. Handles 3 inbound message types from the muscle:
//   - register_embodiment
//   - world_state    (60fps snapshots)
//   - semantic_event (only when threshold broken)
// Forwards bulk_assignment messages from the brain → muscle.

import { WebSocketServer } from "ws";
import { store } from "./world-store.js";
import { logAssignmentResult } from "./packet-logger.js";
import { logEvent, getLogPaths } from "./file-logger.js";

const WS_PORT = 7777;

// Track active assignments per embodiment for packet logging
const activeAssignments = new Map(); // embodiment_id -> { assignment, state_before, ts, events }

export function startWsBridge() {
  const wss = new WebSocketServer({ port: WS_PORT });
  const paths = getLogPaths();
  console.error(`[scp-ws] listening on ws://localhost:${WS_PORT}`);
  console.error(`[scp-ws] file logs: ${paths.runLog}`);
  console.error(`[scp-ws] scp-detail logs: ${paths.scpDetailLog}`);

  wss.on("connection", (ws) => {
    let bound_embodiment_id = null;
    console.error("[scp-ws] muscle connected");

    ws.on("message", (raw) => {
      let pkt;
      try { pkt = JSON.parse(raw.toString()); } catch { return; }
      if (!pkt || !pkt.type) return;

      if (pkt.type === "register_embodiment") {
        const emb = pkt.embodiment;
        if (!emb || !emb.embodiment_id) return;
        store.registerEmbodiment(emb);
        store.attachMuscleSocket(emb.embodiment_id, ws);
        bound_embodiment_id = emb.embodiment_id;
        console.error(`[scp-ws] registered ${emb.embodiment_id} (${(emb.actuators || []).length} actuators)`);
        return;
      }

      if (pkt.type === "world_state") {
        if (!bound_embodiment_id) return;
        store.setWorldState(bound_embodiment_id, pkt.world);
        // Track muscle's current mode so the bridge can skip wakes in no-brainer
        if (pkt.mode) store.setMuscleMode(bound_embodiment_id, pkt.mode);
        // If there's an active assignment waiting on outcome, see if we can close it
        const active = activeAssignments.get(bound_embodiment_id);
        if (active && Date.now() - active.ts > 1500) {
          logAssignmentResult({
            embodiment_id: bound_embodiment_id,
            assignment: active.assignment,
            state_before: active.state_before,
            state_after: pkt.world,
            events: active.events,
            duration_ms: Date.now() - active.ts,
          });
          activeAssignments.delete(bound_embodiment_id);
        }
        return;
      }

      if (pkt.type === "semantic_event") {
        if (!bound_embodiment_id) return;
        store.enqueueEvent(bound_embodiment_id, pkt.event);
        const active = activeAssignments.get(bound_embodiment_id);
        if (active) active.events.push(pkt.event);
        // Mirror semantic events to the file log so the run timeline is complete
        logEvent({
          mode: "muscle",
          tag: `EVENT_${(pkt.event.type || "unknown").toUpperCase()}`,
          payload: pkt.event,
          ts: pkt.event.timestamp ? Date.now() : Date.now(),
        });
        return;
      }

      if (pkt.type === "log_line") {
        // Direct logging from the muscle UI (intercepts, friendly fire,
        // mark_engage decisions, mode changes, pause/resume)
        logEvent({
          mode: pkt.mode || "unknown",
          tag: pkt.tag || "UNKNOWN",
          payload: pkt.payload || {},
          scp_only: !!pkt.scp_only,
          ts: pkt.ts || Date.now(),
        });
        return;
      }
    });

    ws.on("close", () => {
      if (bound_embodiment_id) {
        store.detachMuscleSocket(bound_embodiment_id);
        console.error(`[scp-ws] muscle disconnected (${bound_embodiment_id})`);
      }
    });
  });

  // Hook into store so MCP-driven assignments also start packet windows
  const originalEnqueue = store.enqueueAssignment.bind(store);
  store.enqueueAssignment = (embodiment_id, assignment) => {
    const state_before = store.getWorldState(embodiment_id);
    if (state_before) {
      activeAssignments.set(embodiment_id, {
        assignment,
        state_before,
        ts: Date.now(),
        events: [],
      });
    }
    return originalEnqueue(embodiment_id, assignment);
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`) {
  startWsBridge();
}
