// File logger — writes simulation events to disk so the user can compare
// runs across modes. Two streams:
//
//   runs/run.log         — every event from every mode (full history)
//   runs/scp-detail.log  — events flagged scp_only (brain calls, vetos,
//                           mark_engage decisions, escalations)
//
// Format: one JSON line per event with {ts, mode, tag, payload, score?}
//
// The "real difference maker" comparison is just diffing run.log filtered
// by mode. SCP runs will have additional MARK_ENGAGE / MARK_IGNORE / WAKE
// rows that no-brainer runs lack.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNS_DIR = path.resolve(__dirname, "..", "runs");
const RUN_LOG = path.join(RUNS_DIR, "run.log");
const SCP_DETAIL_LOG = path.join(RUNS_DIR, "scp-detail.log");

if (!fs.existsSync(RUNS_DIR)) {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

let runStream = null;
let scpStream = null;

function ensureStreams() {
  if (!runStream) runStream = fs.createWriteStream(RUN_LOG, { flags: "a" });
  if (!scpStream) scpStream = fs.createWriteStream(SCP_DETAIL_LOG, { flags: "a" });
}

function fmt(ts) {
  const d = new Date(ts);
  return d.toISOString();
}

export function logEvent({ mode, tag, payload, scp_only = false, ts = Date.now() }) {
  ensureStreams();
  const line = JSON.stringify({ ts: fmt(ts), mode, tag, payload }) + "\n";
  runStream.write(line);
  if (scp_only || mode === "scp") {
    scpStream.write(line);
  }
}

export function logBridgeEvent({ tag, payload, ts = Date.now() }) {
  // Bridge-side events (LLM wakes, tool calls, etc.) — always SCP-relevant
  ensureStreams();
  const line = JSON.stringify({ ts: fmt(ts), source: "bridge", tag, payload }) + "\n";
  runStream.write(line);
  scpStream.write(line);
}

export function getLogPaths() {
  return { runLog: RUN_LOG, scpDetailLog: SCP_DETAIL_LOG, runsDir: RUNS_DIR };
}
