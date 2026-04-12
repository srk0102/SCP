// Data factory: every assignment + its outcome events get logged to packets.jsonl
// This is the silent fuel that future LoRA fine-tuning of the vertical stack will
// consume. We don't train anything in MVP — we just collect.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKETS_PATH = path.resolve(__dirname, "..", "packets.jsonl");

let writeStream = null;
function ensureStream() {
  if (!writeStream) {
    writeStream = fs.createWriteStream(PACKETS_PATH, { flags: "a" });
  }
  return writeStream;
}

export function logPacket(packet) {
  const stream = ensureStream();
  stream.write(JSON.stringify(packet) + "\n");
}

export function logAssignmentResult({ embodiment_id, assignment, state_before, state_after, events, duration_ms }) {
  // One row per intent in the bulk assignment, so distillation can grade them individually
  const ts = Date.now();
  for (const intent of assignment.assignments || []) {
    const intent_events = events.filter(e => e.actuator_id === intent.actuator_id);
    const success = intent_events.some(e => e.type === "target_engaged" && e.entity_id === intent.target_entity_id);
    logPacket({
      packet_id: `pkt_${ts}_${Math.random().toString(36).slice(2, 8)}`,
      scp_version: "0.1.0",
      embodiment_id,
      state_before,
      intent,
      state_after,
      result: success ? "success" : (intent_events.length ? "partial" : "failed"),
      duration_ms,
      events: intent_events,
      timestamp: ts,
    });
  }
}

export function getPacketsPath() {
  return PACKETS_PATH;
}
