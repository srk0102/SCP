import { patternStore } from "./pattern-store.js";

// SCP MVP — Border Defense (launcher + interceptor model, v3)
// ============================================================
//
// Real missile-defense architecture:
//   • Each hand is a LAUNCHER stuck to the bottom of the canvas.
//   • Launchers fire INTERCEPTOR projectiles upward at predicted lead points.
//   • Interceptor flies at ~320 px/sec. If it gets within 14 px of its target,
//     both are destroyed. Otherwise it times out after ~4 s.
//   • Each launcher has a 550 ms cooldown — no spamming.
//
// The "cerebellum → cortex" pattern:
//   The LIMB decides what to fire at, from its own POV:
//     - Heat sensor locks on → auto-fire (unless brain vetoed this entity)
//     - Brain-assigned cold target → fire at predicted intercept
//   The LIMB itself emits threat events when it sees something it can't classify:
//     - `threat_detected_unclassified` — a radar-only blip in my zone I can't confirm
//     - `threat_detected_ambiguous`    — a hot thing in my zone but shape/speed weird
//     - `shot_missed`                  — my interceptor timed out without hitting
//     - `engage_confirmed`             — my interceptor destroyed the target
//     - `overwhelmed`                  — too many threats in my zone at once
//
// The BRAIN wakes only on these threat events (and ground breach). Its only job:
//   mark_engage → tell a specific limb to fire at a cold target it can't see
//   mark_ignore → veto a hot target so the limb's heat sensor skips it
//
// That's it. The muscle is the whole control loop. The brain is the classifier.

const SCP_VERSION = "0.1.0";
const WS_URL = "ws://localhost:7777";

// ---------- Geometry ----------
const W = 1200;
const H = 800;
const PX_PER_CM = 40;
const GROUND_Y = 790;
const INTERCEPT_R = 14;

// ---------- Radar (brain's eyes, matches embodiment) ----------
const RADAR_ORIGIN = [600, 790];
const RADAR_R = 520;

// ---------- Spawn / shooter config ----------
const SHOOTER_Y = 18;
const SPAWN_INTERVAL_MS = 700;
const SHOOTER_COUNT = 3;
const PLANE_ALT = 640;        // was 180 — now inside heat-sensor range (BUG FIX)

// ---------- Entity kinds ----------
const KINDS = {
  missile_heat: {
    label: "🔥 heat missile",
    has_heat: true,
    color_body: "#fab387",
    color_tip: "#f9e2af",
    score_intercept: +1,
    score_ground: -1,
    score_friendly_fire: 0,
    base_vy: 65,
    vy_jitter: 25,
    vx_jitter: 30,
    behavior: "fall",
  },
  missile_stealth: {
    label: "🥷 stealth missile",
    has_heat: false,
    color_body: "#6c3483",
    color_tip: "#a569bd",
    score_intercept: +1,
    score_ground: -1,
    score_friendly_fire: 0,
    base_vy: 60,
    vy_jitter: 22,
    vx_jitter: 25,
    behavior: "fall",
  },
  bird: {
    label: "🐦 bird",
    has_heat: false,
    color_body: "#94e2d5",
    color_tip: "#94e2d5",
    score_intercept: 0,
    score_ground: 0,
    score_friendly_fire: -1,
    base_vy: 10,
    vy_jitter: 6,
    vx_jitter: 40,
    behavior: "drift",
  },
  plane: {
    label: "✈️ passenger plane",
    has_heat: true,
    color_body: "#89b4fa",
    color_tip: "#cba6f7",
    score_intercept: 0,
    score_ground: 0,
    score_friendly_fire: -3,
    base_vy: 0,
    vy_jitter: 3,
    vx_jitter: 0,
    behavior: "cruise",
  },
};

const SPAWN_WEIGHTS = [
  { kind: "missile_heat", weight: 38 },
  { kind: "missile_stealth", weight: 27 },
  { kind: "bird", weight: 17 },
  { kind: "plane", weight: 18 },
];

// ---------- State ----------
let embodiment = null;
let ws = null;
let wsConnected = false;
let paused = false;
let lastSpawnTs = 0;

const hands = [];
const entities = [];           // missiles, birds, planes
const interceptors = [];       // projectiles fired by hands
const shooters = [];
let entitySeq = 0;
let interceptorSeq = 0;

let score = 0;
const tally = {
  missile_intercept: 0,
  missile_ground: 0,
  bird_shot: 0,
  plane_shot: 0,
  shots_fired: 0,
  shots_missed: 0,
};

const recentTTKs = [];
const interceptTimestamps = [];
const brainCallTimestamps = [];

const log = (msg, cls = "") => {
  const el = document.getElementById("log");
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = `[${(performance.now() / 1000).toFixed(1)}s] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 250) el.removeChild(el.firstChild);
};

const currentMode = () => document.getElementById("mode").value;

// ---------- Boot ----------
function loadEmbodiment() {
  return fetch("./embodiment.json").then(r => r.json()).then(emb => {
    embodiment = emb;
    hands.length = 0;
    for (const a of emb.actuators) {
      hands.push({
        actuator_id: a.actuator_id,
        base_x: a.rest_position[0],
        base_y: a.rest_position[1],
        sensor_range: a.sensor_range || 260,
        launch_cooldown_ms: a.launch_cooldown_ms || 550,
        interceptor_speed: a.interceptor_speed || 320,
        interceptor_lifetime_ms: a.interceptor_lifetime_ms || 4200,
        last_fire_ts: 0,
        // Brain overrides
        external_target_id: null,          // mark_engage target (cold, muscle can't see)
        ignore_set: new Set(),             // mark_ignore entity ids
        // Tracking for limb-side threat reports
        reported_entities: new Set(),      // entities I've already asked the brain about
        status: "idle",
      });
    }
    shooters.length = 0;
    for (let i = 0; i < SHOOTER_COUNT; i++) {
      shooters.push({
        shooter_id: `sh_${i}`,
        x: ((i + 0.5) / SHOOTER_COUNT) * W,
        y: SHOOTER_Y,
      });
    }
    log(`Loaded ${emb.label} (${hands.length} launchers, sensor=${hands[0].sensor_range}, cooldown=${hands[0].launch_cooldown_ms}ms)`);
  });
}

// ---------- Spawn ----------
function pickKind() {
  const total = SPAWN_WEIGHTS.reduce((a, b) => a + b.weight, 0);
  let roll = Math.random() * total;
  for (const k of SPAWN_WEIGHTS) {
    if (roll < k.weight) return k.kind;
    roll -= k.weight;
  }
  return SPAWN_WEIGHTS[0].kind;
}

function maybeSpawn(now) {
  if (now - lastSpawnTs < SPAWN_INTERVAL_MS) return;
  lastSpawnTs = now;
  const kind = pickKind();
  const cfg = KINDS[kind];
  const id = `${kind}_${entitySeq++}`;

  let x, y, vx, vy;
  if (cfg.behavior === "cruise") {
    // Plane — cruise at PLANE_ALT (inside heat-sensor range)
    const fromLeft = Math.random() < 0.5;
    x = fromLeft ? -40 : W + 40;
    y = PLANE_ALT + (Math.random() - 0.5) * 30;
    vx = fromLeft ? 85 : -85;
    vy = (Math.random() - 0.5) * cfg.vy_jitter;
  } else if (cfg.behavior === "drift") {
    // Bird — drifts at mid altitude
    const fromLeft = Math.random() < 0.5;
    x = fromLeft ? -20 : W + 20;
    y = 260 + Math.random() * 320;
    vx = (fromLeft ? 1 : -1) * (18 + Math.random() * 24);
    vy = (Math.random() - 0.5) * cfg.vy_jitter;
  } else {
    // Missile — falls from a shooter
    const sh = shooters[Math.floor(Math.random() * shooters.length)];
    x = sh.x + (Math.random() - 0.5) * 40;
    y = sh.y + 14;
    vx = (Math.random() - 0.5) * 2 * cfg.vx_jitter;
    vy = cfg.base_vy + Math.random() * cfg.vy_jitter;
  }

  entities.push({
    entity_id: id,
    kind,
    has_heat: cfg.has_heat,
    x, y, vx, vy,
    spawn_ts: now,
    radar_announced: false,
  });
}

function findEntityById(id) {
  for (const e of entities) if (e.entity_id === id) return e;
  return null;
}

function distanceFromRadarOrigin(x, y) {
  const dx = x - RADAR_ORIGIN[0];
  const dy = y - RADAR_ORIGIN[1];
  return Math.hypot(dx, dy);
}

function inRadar(e) {
  return distanceFromRadarOrigin(e.x, e.y) <= RADAR_R;
}

// ---------- Per-limb sensor / threat detection ----------
// Each limb independently checks what it can see via heat sensor.
// This is the cerebellum: it "feels" threats locally and escalates when
// it can't resolve them.

function inHeatRange(hand, e) {
  if (!e.has_heat) return false;
  const dx = e.x - hand.base_x;
  const dy = e.y - hand.base_y;
  // Upper-semi-disc of radius sensor_range around base
  return dx * dx + dy * dy <= hand.sensor_range * hand.sensor_range && e.y < hand.base_y;
}

function inRadarZoneOfLimb(hand, e) {
  // Each limb "owns" a slice of the radar view — the vertical column above its base
  // within ±sensor_range. This is the limb's responsibility zone for limb-side
  // threat reporting.
  if (!inRadar(e)) return false;
  const dx = Math.abs(e.x - hand.base_x);
  return dx <= hand.sensor_range && e.y < hand.base_y;
}

function limbOwnsEntity(hand, e) {
  // Is this hand the closest hand horizontally to this entity?
  let closest = null;
  let best = Infinity;
  for (const h of hands) {
    const d = Math.abs(e.x - h.base_x);
    if (d < best) { best = d; closest = h; }
  }
  return closest === hand;
}

function limbReportThreats(hand, now, mode) {
  if (mode !== "scp") return;  // threat-reporting is SCP-mode behavior
  // For each entity in the limb's zone, decide if the limb understands it:
  //  - If it's hot AND in heat sensor: muscle handles locally (no report)
  //  - If it's cold but I can see on radar (unclassified): REPORT
  //  - If it's hot but I've been told to ignore it: no fire, no report
  //  - If the brain already told me to engage it: no report (I'm on it)
  for (const e of entities) {
    if (!inRadarZoneOfLimb(hand, e)) continue;
    if (!limbOwnsEntity(hand, e)) continue;          // only the nearest limb reports
    if (hand.reported_entities.has(e.entity_id)) continue;
    if (hand.external_target_id === e.entity_id) continue;
    if (hand.ignore_set.has(e.entity_id)) continue;

    // MUSCLE MEMORY: check pattern store before escalating to brain
    const cached = patternStore.lookup(e);
    if (cached === "mark_ignore") {
      hand.ignore_set.add(e.entity_id);
      hand.reported_entities.add(e.entity_id);
      logToFile("CACHE_HIT_IGNORE", { actuator_id: hand.actuator_id, entity_id: e.entity_id }, true);
      log(`🧠 CACHE → ignore ${e.entity_id}`, "ev");
      continue; // no brain call
    }
    if (cached === "mark_engage") {
      hand.external_target_id = e.entity_id;
      hand.reported_entities.add(e.entity_id);
      logToFile("CACHE_HIT_ENGAGE", { actuator_id: hand.actuator_id, entity_id: e.entity_id }, true);
      log(`🧠 CACHE → engage ${e.entity_id}`, "ev");
      continue; // no brain call
    }
    // Cache miss — escalate to brain as normal

    if (e.has_heat && inHeatRange(hand, e)) {
      // Hot + in my sensor → muscle will auto-fire. I'll ask the brain IF this
      // could be a friendly (plane) — the heat sensor can't tell missile from plane.
      hand.reported_entities.add(e.entity_id);
      emit({
        type: "force_threshold_exceeded",  // reuse schema name for "ambiguous hot contact"
        actuator_id: hand.actuator_id,
        entity_id: e.entity_id,
        cause: "hot_contact_unclassified",
        delta_state: {
          position: [Math.round(e.x), Math.round(e.y)],
          velocity: [Math.round(e.vx), Math.round(e.vy)],
          note: "heat sensor lit up, cannot tell missile from friendly",
        },
      });
      logToFile("LIMB_THREAT_HOT_AMBIGUOUS", { actuator_id: hand.actuator_id, entity_id: e.entity_id }, true);
    } else if (!e.has_heat) {
      // Cold but visible on radar → I can't see it with my heat sensor. Ask the brain.
      hand.reported_entities.add(e.entity_id);
      emit({
        type: "reallocation_requested",
        actuator_id: hand.actuator_id,
        entity_id: e.entity_id,
        cause: "cold_contact_unclassified",
        delta_state: {
          position: [Math.round(e.x), Math.round(e.y)],
          velocity: [Math.round(e.vx), Math.round(e.vy)],
          note: "radar blip with no heat, need classification",
        },
      });
      logToFile("LIMB_THREAT_COLD", { actuator_id: hand.actuator_id, entity_id: e.entity_id }, true);
    }
  }
  // Clean up reported_entities for entities that no longer exist
  for (const id of Array.from(hand.reported_entities)) {
    if (!findEntityById(id)) hand.reported_entities.delete(id);
  }
}

// ---------- Heat-sensor auto-acquisition + firing decision ----------
function nearestHotInSensor(hand) {
  let best = null;
  let bestScore = Infinity;
  for (const e of entities) {
    if (!inHeatRange(hand, e)) continue;
    if (hand.ignore_set.has(e.entity_id)) continue;
    // Skip entities already being targeted by an in-flight interceptor from ANY hand
    const claimed = interceptors.some(it => it.target_id === e.entity_id);
    if (claimed) continue;
    // Prefer lower (closer to ground) and closer to base
    const urgency = e.y;
    const dist = Math.hypot(e.x - hand.base_x, e.y - hand.base_y);
    const score = -urgency * 1.2 + dist;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

// Compute lead intercept point given hand and target
function computeLeadPoint(hand, target, interceptor_speed) {
  const dx = target.x - hand.base_x;
  const dy = target.y - hand.base_y;
  const dist = Math.hypot(dx, dy);
  const t = dist / interceptor_speed;
  return [target.x + target.vx * t, target.y + target.vy * t];
}

function fireInterceptor(hand, target, now) {
  const [lx, ly] = computeLeadPoint(hand, target, hand.interceptor_speed);
  const vx = lx - hand.base_x;
  const vy = ly - hand.base_y;
  const n = Math.hypot(vx, vy) || 1;
  const interceptor = {
    interceptor_id: `int_${interceptorSeq++}`,
    fired_by: hand.actuator_id,
    target_id: target.entity_id,
    x: hand.base_x,
    y: hand.base_y - 10,
    vx: (vx / n) * hand.interceptor_speed,
    vy: (vy / n) * hand.interceptor_speed,
    spawn_ts: now,
    lifetime_ms: hand.interceptor_lifetime_ms,
  };
  interceptors.push(interceptor);
  hand.last_fire_ts = now;
  tally.shots_fired++;
  logToFile("LAUNCH", { actuator_id: hand.actuator_id, interceptor_id: interceptor.interceptor_id, target_id: target.entity_id, target_kind: target.kind });
}

function stepHand(h, dt, now) {
  const mode = currentMode();

  // Cooldown check
  if (now - h.last_fire_ts < h.launch_cooldown_ms) {
    h.status = "cooldown";
    limbReportThreats(h, now, mode);
    return;
  }

  // Decide what to fire at (if anything)
  let target = null;

  // 1. External target from brain (cold target override)
  if ((mode === "scp" || mode === "brainer") && h.external_target_id) {
    const ext = findEntityById(h.external_target_id);
    if (ext) target = ext;
    else h.external_target_id = null;
  }

  // 2. Local heat-sensor auto-fire (no-brainer + scp)
  if (!target && (mode === "no-brainer" || mode === "scp")) {
    const next = nearestHotInSensor(h);
    if (next) target = next;
  }

  // 3. Brainer mode: only external targets (LLM assigned). Heat sensor disabled.
  // (nothing more to do here — target stays null if brain hasn't spoken)

  if (target) {
    fireInterceptor(h, target, now);
    h.status = "fired";
  } else {
    h.status = "idle";
  }

  limbReportThreats(h, now, mode);
}

// ---------- Interceptor physics ----------
function stepInterceptors(dt, now) {
  for (let i = interceptors.length - 1; i >= 0; i--) {
    const it = interceptors[i];
    it.x += it.vx * dt;
    it.y += it.vy * dt;

    // Lifetime
    if (now - it.spawn_ts > it.lifetime_ms) {
      onShotMissed(it, "lifetime_expired");
      interceptors.splice(i, 1);
      continue;
    }

    // Out-of-bounds
    if (it.x < -20 || it.x > W + 20 || it.y < -20 || it.y > H + 20) {
      onShotMissed(it, "out_of_bounds");
      interceptors.splice(i, 1);
      continue;
    }

    // Collision with target
    const target = findEntityById(it.target_id);
    if (target) {
      const dx = target.x - it.x;
      const dy = target.y - it.y;
      if (dx * dx + dy * dy < INTERCEPT_R * INTERCEPT_R) {
        onIntercept(it, target);
        interceptors.splice(i, 1);
        // target was removed inside onIntercept
        continue;
      }
    } else {
      // Target already gone (another interceptor got it). This shot is now a miss.
      onShotMissed(it, "target_gone");
      interceptors.splice(i, 1);
    }
  }
}

function onIntercept(it, e) {
  const cfg = KINDS[e.kind];
  const isFriendly = cfg.score_friendly_fire !== 0;
  const delta = isFriendly ? cfg.score_friendly_fire : cfg.score_intercept;
  score += delta;

  if (e.kind === "missile_heat" || e.kind === "missile_stealth") tally.missile_intercept++;
  else if (e.kind === "bird") tally.bird_shot++;
  else if (e.kind === "plane") tally.plane_shot++;

  const ttk = performance.now() - e.spawn_ts;
  recentTTKs.push(ttk);
  if (recentTTKs.length > 50) recentTTKs.shift();
  interceptTimestamps.push(performance.now());

  const idx = entities.indexOf(e);
  if (idx >= 0) entities.splice(idx, 1);

  // Free the firing hand's external slot if it was this target
  const fh = hands.find(h => h.actuator_id === it.fired_by);
  if (fh && fh.external_target_id === e.entity_id) fh.external_target_id = null;

  emit({
    type: "target_engaged",
    actuator_id: it.fired_by,
    entity_id: e.entity_id,
    cause: isFriendly ? "friendly_fire" : "intercept_confirmed",
    delta_state: { kind: e.kind, ttk_ms: Math.round(ttk), score_delta: delta, intercept_pos: [Math.round(it.x), Math.round(it.y)] },
  });
  const tag = isFriendly ? "FRIENDLY_FIRE" : "INTERCEPT";
  logToFile(tag, { actuator_id: it.fired_by, entity_id: e.entity_id, kind: e.kind, score_delta: delta, score_total: score });
  log(`${isFriendly ? "💥 FF" : "✓ HIT"} ${it.fired_by} → ${e.kind} (${delta > 0 ? "+" : ""}${delta})`, isFriendly ? "er" : "ev");
}

function onShotMissed(it, reason) {
  tally.shots_missed++;
  emit({
    type: "intent_failed",
    actuator_id: it.fired_by,
    entity_id: it.target_id,
    cause: `shot_missed:${reason}`,
    delta_state: { interceptor_id: it.interceptor_id },
  });
  logToFile("SHOT_MISSED", { actuator_id: it.fired_by, interceptor_id: it.interceptor_id, reason }, true);
}

function onEntityDespawn(e, reason) {
  if (reason === "ground_breach" && (e.kind === "missile_heat" || e.kind === "missile_stealth")) {
    tally.missile_ground++;
    score += KINDS[e.kind].score_ground;
    emit({
      type: "intent_failed",
      entity_id: e.entity_id,
      cause: "ground_breach",
      delta_state: { kind: e.kind, final_pos: [Math.round(e.x), Math.round(e.y)], score_delta: KINDS[e.kind].score_ground },
    });
    logToFile("GROUND_BREACH", { entity_id: e.entity_id, kind: e.kind, score_delta: KINDS[e.kind].score_ground, score_total: score });
    log(`✗ MISS ${e.kind} reached ground (-1)`, "er");
  } else if (reason === "off_canvas") {
    logToFile("OFF_CANVAS", { entity_id: e.entity_id, kind: e.kind });
  }
  // Clear any hand that was chasing this entity
  for (const h of hands) {
    if (h.external_target_id === e.entity_id) h.external_target_id = null;
    h.reported_entities.delete(e.entity_id);
  }
}

// ---------- Step ----------
function step(dt, now) {
  if (paused) return;
  maybeSpawn(now);

  // Move entities, despawn at boundaries
  for (let i = entities.length - 1; i >= 0; i--) {
    const e = entities[i];
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    if (e.y >= GROUND_Y) {
      onEntityDespawn(e, "ground_breach");
      entities.splice(i, 1);
      continue;
    }
    if (e.x < -60 || e.x > W + 60 || e.y < -40) {
      onEntityDespawn(e, "off_canvas");
      entities.splice(i, 1);
      continue;
    }
  }

  for (const h of hands) stepHand(h, dt, now);
  stepInterceptors(dt, now);
}

// ---------- Render ----------
const canvas = document.getElementById("canvas");
canvas.width = W;
canvas.height = H;
const ctx = canvas.getContext("2d");

function render() {
  // Background
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#0b0e14");
  grad.addColorStop(0.85, "#1a1d28");
  grad.addColorStop(1, "#2a1d18");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Grid
  ctx.strokeStyle = "#1a1d28";
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 60) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Radar arc
  ctx.strokeStyle = "rgba(166,227,161,0.35)";
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(RADAR_ORIGIN[0], RADAR_ORIGIN[1], RADAR_R, Math.PI, 2 * Math.PI);
  ctx.stroke();
  ctx.fillStyle = "rgba(166,227,161,0.03)";
  ctx.beginPath();
  ctx.arc(RADAR_ORIGIN[0], RADAR_ORIGIN[1], RADAR_R, Math.PI, 2 * Math.PI);
  ctx.fill();
  ctx.setLineDash([]);
  ctx.font = "10px ui-monospace";
  ctx.fillStyle = "rgba(166,227,161,0.6)";
  ctx.fillText("RADAR", RADAR_ORIGIN[0] - RADAR_R + 8, RADAR_ORIGIN[1] - 8);

  // Ground line
  ctx.strokeStyle = "#f38ba8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(W, GROUND_Y);
  ctx.stroke();

  // Shooters
  for (const sh of shooters) {
    ctx.fillStyle = "#f38ba8";
    ctx.fillRect(sh.x - 16, sh.y - 8, 32, 16);
    ctx.fillStyle = "#1e2030";
    ctx.fillRect(sh.x - 4, sh.y + 6, 8, 10);
  }

  // Heat sensor zones (very faint semi-disc around each base)
  for (const h of hands) {
    ctx.strokeStyle = "rgba(243,139,168,0.08)";
    ctx.beginPath();
    ctx.arc(h.base_x, h.base_y, h.sensor_range, Math.PI, 2 * Math.PI);
    ctx.stroke();
  }

  // Entities
  for (const e of entities) drawEntity(e);

  // Interceptors
  for (const it of interceptors) drawInterceptor(it);

  // Launchers
  hands.forEach((h, i) => {
    const hue = (i * 36) % 360;
    // Base
    ctx.fillStyle = `hsl(${hue}, 60%, 40%)`;
    ctx.fillRect(h.base_x - 10, h.base_y - 6, 20, 16);
    // Launch barrel — tilt based on next intended target for visual effect
    let aimX = h.base_x;
    let aimY = h.base_y - 20;
    // cooldown glow
    const now = performance.now();
    const cd = Math.max(0, 1 - (now - h.last_fire_ts) / h.launch_cooldown_ms);
    ctx.strokeStyle = cd > 0 ? `hsl(${hue}, 70%, ${60 - cd * 20}%)` : `hsl(${hue}, 80%, 65%)`;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(h.base_x, h.base_y);
    ctx.lineTo(aimX, aimY);
    ctx.stroke();
    // Index label
    ctx.fillStyle = "#11131a";
    ctx.font = "10px ui-monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i), h.base_x, h.base_y + 2);
    // Cooldown bar
    if (cd > 0) {
      ctx.fillStyle = `rgba(249,226,175,${0.6})`;
      ctx.fillRect(h.base_x - 10, h.base_y + 12, 20 * (1 - cd), 2);
    }
  });

  // HUD bar (top of canvas — timer + model calls + cache hits)
  if (sessionStartTs > 0) {
    elapsedMs = paused ? elapsedMs : (performance.now() - sessionStartTs);
    const totalSec = Math.floor(elapsedMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const timerStr = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    const cStats = patternStore.stats();
    const modelCalls = brainCallTimestamps.length;

    ctx.fillStyle = "rgba(11,14,20,0.7)";
    ctx.fillRect(0, 0, W, 32);

    ctx.font = "bold 18px ui-monospace";
    ctx.textBaseline = "middle";

    // Timer (center)
    ctx.fillStyle = totalSec >= 180 ? "#f38ba8" : "#f9e2af";
    ctx.textAlign = "center";
    ctx.fillText(timerStr, W / 2, 17);

    // Model calls (left)
    ctx.fillStyle = "#cba6f7";
    ctx.textAlign = "left";
    ctx.fillText(`MODEL: ${modelCalls}`, 12, 17);

    // Cache hits (right)
    ctx.fillStyle = "#a6e3a1";
    ctx.textAlign = "right";
    ctx.fillText(`CACHE: ${cStats.hits}h / ${cStats.misses}m`, W - 12, 17);
  }

  // Pause overlay
  if (paused) {
    ctx.fillStyle = "rgba(11,14,20,0.55)";
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#f9e2af";
    ctx.font = "bold 36px ui-monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PAUSED — press SPACE or click ▶", W / 2, H / 2);
  }
}

function drawEntity(e) {
  const cfg = KINDS[e.kind];
  if (cfg.behavior === "fall") {
    ctx.save();
    ctx.translate(e.x, e.y);
    const angle = Math.atan2(e.vy, e.vx) - Math.PI / 2;
    ctx.rotate(angle);
    ctx.fillStyle = cfg.color_body;
    ctx.fillRect(-4, -9, 8, 18);
    ctx.fillStyle = cfg.color_tip;
    ctx.beginPath();
    ctx.moveTo(0, -13);
    ctx.lineTo(-4, -9);
    ctx.lineTo(4, -9);
    ctx.closePath();
    ctx.fill();
    if (e.has_heat) {
      ctx.fillStyle = "rgba(249,226,175,0.6)";
      ctx.beginPath();
      ctx.moveTo(0, 16);
      ctx.lineTo(-4, 9);
      ctx.lineTo(4, 9);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = "rgba(165,105,189,0.6)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  } else if (cfg.behavior === "drift") {
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.strokeStyle = cfg.color_body;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-6, 2);
    ctx.lineTo(0, -3);
    ctx.lineTo(6, 2);
    ctx.stroke();
    ctx.restore();
  } else if (cfg.behavior === "cruise") {
    ctx.save();
    ctx.translate(e.x, e.y);
    if (e.vx < 0) ctx.scale(-1, 1);
    ctx.fillStyle = cfg.color_body;
    ctx.fillRect(-22, -4, 44, 8);
    ctx.fillStyle = cfg.color_tip;
    ctx.beginPath();
    ctx.moveTo(0, -4);
    ctx.lineTo(-10, -12);
    ctx.lineTo(10, -12);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(0, 4);
    ctx.lineTo(-10, 12);
    ctx.lineTo(10, 12);
    ctx.closePath();
    ctx.fill();
    // Engine glow (heat signature)
    ctx.fillStyle = "rgba(249,226,175,0.7)";
    ctx.beginPath();
    ctx.arc(-18, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(18, 0, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function drawInterceptor(it) {
  ctx.save();
  ctx.translate(it.x, it.y);
  const angle = Math.atan2(it.vy, it.vx) - Math.PI / 2;
  ctx.rotate(angle);
  ctx.fillStyle = "#a6e3a1";
  ctx.beginPath();
  ctx.moveTo(0, -8);
  ctx.lineTo(-3, 4);
  ctx.lineTo(3, 4);
  ctx.closePath();
  ctx.fill();
  // Flame
  ctx.fillStyle = "rgba(249,226,175,0.55)";
  ctx.beginPath();
  ctx.moveTo(0, 8);
  ctx.lineTo(-3, 4);
  ctx.lineTo(3, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ---------- Metrics ----------
let lastFpsTs = performance.now();
let fpsFrames = 0;
let displayFps = 0;
function trimWindow(arr, cutoff) { while (arr.length && arr[0] < cutoff) arr.shift(); }
function updateMetrics() {
  const now = performance.now();
  fpsFrames++;
  if (now - lastFpsTs >= 500) {
    displayFps = Math.round((fpsFrames * 1000) / (now - lastFpsTs));
    fpsFrames = 0;
    lastFpsTs = now;
  }
  const cutoff = now - 60_000;
  trimWindow(interceptTimestamps, cutoff);
  trimWindow(brainCallTimestamps, cutoff);

  const ttkAvg = recentTTKs.length ? Math.round(recentTTKs.reduce((a, b) => a + b, 0) / recentTTKs.length) : "—";
  const accuracy = tally.shots_fired > 0 ? Math.round((tally.missile_intercept / tally.shots_fired) * 100) : 0;

  document.getElementById("m-fps").textContent = displayFps;
  document.getElementById("m-score").textContent = score;
  document.getElementById("m-mi").textContent = tally.missile_intercept;
  document.getElementById("m-mb").textContent = tally.missile_ground;
  document.getElementById("m-pf").textContent = `${tally.plane_shot} pl / ${tally.bird_shot} bd`;
  document.getElementById("m-ttk").textContent = ttkAvg;
  document.getElementById("m-bcm").textContent = brainCallTimestamps.length;
  document.getElementById("m-balls").textContent = `${entities.length} / ${interceptors.length}i / ${accuracy}%`;
  const cstats = patternStore.stats();
  document.getElementById("m-cache").textContent = `${cstats.hits}h/${cstats.misses}m (${cstats.confident}p)`;
  // Persist patterns every 5 seconds (not every frame — saves CPU)
  if (Math.floor(now / 5000) !== Math.floor((now - 500) / 5000)) patternStore.save();
}

// ---------- WebSocket ----------
function connectWs() {
  try { ws = new WebSocket(WS_URL); }
  catch { setTimeout(connectWs, 1500); return; }
  ws.onopen = () => {
    wsConnected = true;
    document.getElementById("ws").className = "ws up";
    document.getElementById("ws").textContent = "WS: connected";
    log("WS connected, registering embodiment", "ev");
    ws.send(JSON.stringify({ type: "register_embodiment", scp_version: SCP_VERSION, embodiment }));
  };
  ws.onclose = () => {
    wsConnected = false;
    document.getElementById("ws").className = "ws down";
    document.getElementById("ws").textContent = "WS: disconnected";
    setTimeout(connectWs, 1500);
  };
  ws.onerror = () => {};
  ws.onmessage = (msg) => {
    let pkt;
    try { pkt = JSON.parse(msg.data); } catch { return; }
    handleServerMessage(pkt);
  };
}

function handleServerMessage(pkt) {
  if (pkt.type === "bulk_assignment") {
    brainCallTimestamps.push(performance.now());
    applyBulkAssignment(pkt);
  }
}

function applyBulkAssignment(pkt) {
  const mode = currentMode();
  const assigns = pkt.assignments || [];
  let n = 0;
  for (const intent of assigns) {
    const h = hands.find(x => x.actuator_id === intent.actuator_id);
    if (!h) continue;

    // Brainer mode: only accept engage_target (direct target commands).
    // mark_engage/mark_ignore are SCP-layer concepts that don't apply when
    // the brain is the entire control loop.
    if (mode === "brainer" && intent.type !== "engage_target" && intent.type !== "halt") continue;

    if (intent.type === "mark_engage") {
      h.external_target_id = intent.target_entity_id || null;
      n++;
      logToFile("MARK_ENGAGE", { actuator_id: h.actuator_id, entity_id: intent.target_entity_id }, true);
      // LEARN: brain said engage this entity — cache the pattern
      const ent = findEntityById(intent.target_entity_id);
      if (ent) patternStore.learn(ent, "mark_engage");
    } else if (intent.type === "mark_ignore") {
      if (intent.target_entity_id) h.ignore_set.add(intent.target_entity_id);
      n++;
      logToFile("MARK_IGNORE", { actuator_id: h.actuator_id, entity_id: intent.target_entity_id }, true);
      // LEARN: brain said ignore this entity — cache the pattern
      const ent = findEntityById(intent.target_entity_id);
      if (ent) patternStore.learn(ent, "mark_ignore");
    } else if (intent.type === "engage_target") {
      h.external_target_id = intent.target_entity_id || null;
      n++;
    } else if (intent.type === "halt") {
      h.external_target_id = null;
      n++;
    }
  }
  log(`ASSIGN ${n}/${assigns.length} from brain`, "as");
}

// World snapshot — the brain only sees entities that SOMEONE has reported
// (either a limb or the radar). In this new version we send ONLY:
//   - entities where has_heat=false (cold — muscle can't see them)
//   - entities where kind=plane (hot non-threat — muscle might mis-fire)
// Heat missiles are HIDDEN — muscle handles them on its own, brain doesn't need to know.
function snapshotWorld() {
  return {
    scp_version: SCP_VERSION,
    timestamp: performance.now(),
    embodiment_id: embodiment.embodiment_id,
    actuators: hands.map(h => ({
      actuator_id: h.actuator_id,
      position: [h.base_x, h.base_y],
      velocity: [0, 0],
      current_target: h.external_target_id,
      status: h.status,
    })),
    entities: entities
      .filter(e => inRadar(e))
      .filter(e => !e.has_heat || e.kind === "plane")
      .map(e => ({
        entity_id: e.entity_id,
        position: [Math.round(e.x), Math.round(e.y)],
        velocity: [Math.round(e.vx), Math.round(e.vy)],
        kind: e.kind,
        has_heat: e.has_heat,
        claimed_by: hands.find(h => h.external_target_id === e.entity_id)?.actuator_id || null,
      })),
  };
}

let lastWorldPush = 0;
function pushWorldState(now) {
  if (!wsConnected) return;
  if (now - lastWorldPush < 300) return;
  lastWorldPush = now;
  ws.send(JSON.stringify({ type: "world_state", scp_version: SCP_VERSION, mode: currentMode(), world: snapshotWorld() }));
}

function emit(event) {
  if (!wsConnected) return;
  ws.send(JSON.stringify({
    type: "semantic_event",
    scp_version: SCP_VERSION,
    event: {
      ...event,
      event_id: `e_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      scp_version: SCP_VERSION,
      timestamp: performance.now(),
    },
  }));
}

function logToFile(tag, payload, scp_only = false) {
  if (!wsConnected) return;
  ws.send(JSON.stringify({
    type: "log_line",
    mode: currentMode(),
    scp_only,
    tag,
    payload,
    ts: Date.now(),
  }));
}

// ---------- Main loop ----------
let lastTs = performance.now();
function loop(ts) {
  const dt = paused ? 0 : Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  step(dt, ts);
  pushWorldState(ts);
  render();
  updateMetrics();
  requestAnimationFrame(loop);
}

// ---------- Controls ----------
let sessionStartTs = 0;
let elapsedMs = 0;

function setPaused(p) {
  paused = p;
  document.getElementById("playpause").textContent = paused ? "▶ Play" : "⏸ Pause";
  if (!paused && sessionStartTs === 0) sessionStartTs = performance.now();
  log(paused ? "⏸ PAUSED" : "▶ RESUMED", "as");
  logToFile(paused ? "PAUSE" : "RESUME", { mode: currentMode() });
}

document.getElementById("playpause").addEventListener("click", () => setPaused(!paused));
document.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    setPaused(!paused);
  }
});

document.getElementById("reset").addEventListener("click", () => {
  entities.length = 0;
  interceptors.length = 0;
  score = 0;
  for (const k of Object.keys(tally)) tally[k] = 0;
  recentTTKs.length = 0;
  interceptTimestamps.length = 0;
  brainCallTimestamps.length = 0;
  for (const h of hands) {
    h.external_target_id = null;
    h.ignore_set.clear();
    h.reported_entities.clear();
    h.last_fire_ts = 0;
  }
  log("RESET", "ev");
  logToFile("RESET", { mode: currentMode() });
});

document.getElementById("mode").addEventListener("change", (e) => {
  log(`MODE = ${e.target.value}`, "as");
  logToFile("MODE_CHANGE", { mode: e.target.value });
});

// ---------- Boot ----------
loadEmbodiment().then(() => {
  patternStore.load();
  connectWs();
  setPaused(true);
  requestAnimationFrame(loop);
});
