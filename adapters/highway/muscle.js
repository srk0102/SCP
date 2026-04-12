// SCP Highway Adapter — 10-lane divided highway
// Same protocol, same brain, same server. Different body.
import { patternStore } from "./pattern-store.js";

const SCP_VERSION = "0.1.0";
const WS_URL = "ws://localhost:7777";

// ---- Road geometry ----
const CANVAS_W = 600;
const OUR_LANES = 5;
const OPP_LANES = 5;
const LANE_W = 48;
const DIVIDER_W = 24;
// Opposite side on LEFT, divider in middle, OUR side on RIGHT
const OPP_LEFT = 10;
const OPP_RIGHT = OPP_LEFT + OPP_LANES * LANE_W;
const DIV_LEFT = OPP_RIGHT;
const DIV_RIGHT = DIV_LEFT + DIVIDER_W;
const OUR_LEFT = DIV_RIGHT;
const OUR_RIGHT = OUR_LEFT + OUR_LANES * LANE_W;

function ourLaneCenter(i) { return OUR_LEFT + LANE_W / 2 + i * LANE_W; }
function oppLaneCenter(i) { return OPP_LEFT + LANE_W / 2 + i * LANE_W; }

// ---- Sensors ----
const CAMERA_RANGE = 280;
const CAMERA_FOV = Math.PI * 0.65;
const LIDAR_RANGE = 320;
const RADAR_RANGE = 500;
const OUTER_RADAR = RADAR_RANGE;
const INNER_RADAR = LIDAR_RANGE;

// ---- Traffic signals ----
const SIGNAL_SPACING = 4000;  // px between signals
const SIGNAL_CYCLE = [
  { state: "green", duration: 360 },  // 6s @60fps
  { state: "yellow", duration: 120 }, // 2s
  { state: "red", duration: 360 },    // 6s
];

// ---- Spawn ----
const SPAWN_INTERVAL = 70; // moderate traffic — let muscle learn first
const MIN_SPAWN_DIST = 600;
const MAX_SPAWN_DIST = 1400;
const BEHIND_CHANCE = 0.25;
const BEHIND_DIST = 400;
const SPAWN_WEIGHTS = [
  { kind: "traffic_car", weight: 35 },
  { kind: "rash_driver", weight: 12 },
  { kind: "ambulance", weight: 12 },
  { kind: "obstacle", weight: 10 },
  { kind: "auto_rickshaw", weight: 12 },
  { kind: "motorcycle", weight: 10 },
  { kind: "opp_traffic", weight: 9 },
];
const CHAOS_WEIGHTS = [
  { kind: "traffic_car", weight: 20 },
  { kind: "rash_driver", weight: 20 },
  { kind: "ambulance", weight: 10 },
  { kind: "obstacle", weight: 8 },
  { kind: "auto_rickshaw", weight: 18 },
  { kind: "motorcycle", weight: 16 },
  { kind: "opp_traffic", weight: 8 },
];

const ENTITY_COLORS = {
  traffic_car: "#a6adc8",
  rash_driver: "#f5c2e7",
  ambulance: "#f38ba8",
  obstacle: "#fab387",
  auto_rickshaw: "#94e2d5",
  motorcycle: "#f5c2e7",
  pedestrian: "#eba0ac",
  opp_traffic: "#585b70",
  opp_ambulance: "#f38ba8",
};

// ---- Lane narrowing zones ----
const NARROW_SPACING = 12000; // px between narrowing zones
const NARROW_LENGTH = 2000;   // how long the narrowed section is
// Narrow zones block lanes 0 and 4, leaving inner 3 lanes (1-3) open
const narrowZones = [];

function initNarrowZones() {
  narrowZones.length = 0;
  for (let i = 1; i <= 4; i++) {
    narrowZones.push({ y: -i * NARROW_SPACING, length: NARROW_LENGTH });
  }
}
function ensureNarrowZones() {
  const furthestY = Math.min(...narrowZones.map(z => z.y));
  if (ego.y - furthestY < NARROW_SPACING * 2) {
    narrowZones.push({ y: furthestY - NARROW_SPACING, length: NARROW_LENGTH });
  }
  for (let i = narrowZones.length - 1; i >= 0; i--) {
    if (narrowZones[i].y > ego.y + 3000) narrowZones.splice(i, 1);
  }
}
function getActiveNarrowZone() {
  for (const z of narrowZones) {
    // ego is inside this zone (zone.y is top, zone.y + length is bottom)
    if (ego.y <= z.y + z.length && ego.y >= z.y) return z;
  }
  return null;
}
function getApproachingNarrowZone() {
  let best = null, bestDist = Infinity;
  for (const z of narrowZones) {
    const dist = ego.y - (z.y + z.length); // positive = zone entrance is ahead
    if (dist > 0 && dist < 500 && dist < bestDist) { bestDist = dist; best = z; }
  }
  return best;
}

// ---- Scoring ----
const SC = { dist: 0.01, sigObey: 2, sigRun: -10, ambYield: 5, ambWrong: -3, pedStop: 5, pedHit: -50, collision: -10, laneMerge: 2 };

// ---- State ----
let embodiment = null, ws = null, wsConnected = false, paused = true;
let sessionStartTs = 0, elapsedMs = 0, frameCount = 0, spawnCounter = 0;
let score = 0, distanceDriven = 0, collisions = 0, signalsObeyed = 0;
let ambYielded = 0, pedStops = 0, brainCalls = 0, totalCost = 0;
let currentLane = 2, targetLane = 2;

const traffic = [];
const signals = [];
let ego = null;
const passedSignals = new Set(); // track signal objects we've already scored

// ---- Utility ----
function lerp(a, b, t) { return a + (b - a) * t; }
function getIntersection(A, B, C, D) {
  const tTop = (D.x-C.x)*(A.y-C.y)-(D.y-C.y)*(A.x-C.x);
  const uTop = (C.y-A.y)*(A.x-B.x)-(C.x-A.x)*(A.y-B.y);
  const bot = (D.y-C.y)*(B.x-A.x)-(D.x-C.x)*(B.y-A.y);
  if (bot !== 0) { const t = tTop/bot, u = uTop/bot; if (t>=0&&t<=1&&u>=0&&u<=1) return {x:lerp(A.x,B.x,t),y:lerp(A.y,B.y,t),offset:t}; }
  return null;
}
function polysIntersect(p1,p2) {
  for (let i=0;i<p1.length;i++) for (let j=0;j<p2.length;j++) { if (getIntersection(p1[i],p1[(i+1)%p1.length],p2[j],p2[(j+1)%p2.length])) return true; }
  return false;
}

// ---- Car class ----
class Car {
  constructor(x, y, w, h, kind, speed = 2) {
    this.x = x; this.y = y; this.width = w; this.height = h;
    this.kind = kind; this.speed = speed; this.maxSpeed = speed;
    this.angle = 0; this.damaged = false; this.polygon = [];
    this.entity_id = `${kind}_${Math.floor(Math.random()*10000)}`;
    this.brain_action = null; this.reported = false; this.passed = false;
    this._hasSiren = kind === "ambulance" || kind === "opp_ambulance";
    this._rashTimer = 0; this._rashInterval = 60 + Math.floor(Math.random()*120);
    this._targetX = undefined;
    this.isOpposite = kind === "opp_traffic" || kind === "opp_ambulance";
    this.acceleration = 0.2; this.friction = 0.05;
    this.forward = kind !== "obstacle" && kind !== "pedestrian";
  }
  update() {
    if (this.forward) {
      if (this.isOpposite) this.y += this.speed; // opposite direction
      else this.y -= this.speed;
    }
    this.polygon = this._poly();
  }
  _poly() {
    const rad = Math.hypot(this.width, this.height) / 2;
    const a = Math.atan2(this.width, this.height);
    return [
      { x: this.x - Math.sin(-a) * rad, y: this.y - Math.cos(-a) * rad },
      { x: this.x - Math.sin(a) * rad, y: this.y - Math.cos(a) * rad },
      { x: this.x - Math.sin(Math.PI - a) * rad, y: this.y - Math.cos(Math.PI - a) * rad },
      { x: this.x - Math.sin(Math.PI + a) * rad, y: this.y - Math.cos(Math.PI + a) * rad },
    ];
  }
  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    // Opposite traffic faces the other way (rotated 180°)
    if (this.isOpposite) ctx.rotate(Math.PI);

    const hw = this.width / 2, hh = this.height / 2;
    // Car body
    ctx.fillStyle = this.damaged ? "gray" : (ENTITY_COLORS[this.kind] || "#666");
    ctx.fillRect(-hw, -hh, this.width, this.height);
    // Windshield (front = top when going up)
    ctx.fillStyle = "rgba(137,180,250,0.4)";
    ctx.fillRect(-hw + 3, -hh, this.width - 6, 8);
    // Taillights (rear = bottom)
    ctx.fillStyle = "rgba(243,139,168,0.6)";
    ctx.fillRect(-hw + 2, hh - 4, 5, 3);
    ctx.fillRect(hw - 7, hh - 4, 5, 3);

    ctx.restore();

    // Entity icons (drawn without rotation so emojis are readable)
    if (this._hasSiren) { ctx.fillStyle="#fff"; ctx.font="10px ui-monospace"; ctx.textAlign="center"; ctx.fillText("🚑",this.x,this.y+4); }
    if (this.kind === "auto_rickshaw") { ctx.fillStyle="#fff"; ctx.font="8px ui-monospace"; ctx.textAlign="center"; ctx.fillText("🛺",this.x,this.y+3); }
    if (this.kind === "motorcycle") { ctx.fillStyle="#fff"; ctx.font="8px ui-monospace"; ctx.textAlign="center"; ctx.fillText("🏍",this.x,this.y+3); }
    if (this.kind === "pedestrian") { ctx.fillStyle="#fff"; ctx.font="10px ui-monospace"; ctx.textAlign="center"; ctx.fillText("🚶",this.x,this.y+4); }
  }
}

// ---- Ego car ----
function initEgo() {
  ego = new Car(ourLaneCenter(2), 100, 28, 48, "ego", 2.8); // sensible highway speed
  ego.update();
}

// ---- Sensor features ----
function isStoppedAtSignal(t) {
  if (t.speed > 0.2) return false;
  for (const s of signals) {
    const dist = t.y - s.y;
    if (dist < 0 && dist > -120 && (s.state === "red" || s.state === "yellow")) return true;
  }
  return false;
}
function getSensorFeatures(t) {
  const isOpp = t.x < OUR_LEFT; // opposite side = left of our lanes
  return {
    is_stationary: t.speed < 0.2 && !isStoppedAtSignal(t),
    is_fast: t.speed > 4,
    is_erratic: !t._pushedByEgo && t._targetX !== undefined && Math.abs((t._targetX || t.x) - t.x) > 5,
    has_siren: !!t._hasSiren,
    is_pedestrian: t.kind === "pedestrian",
    same_side: !isOpp,
    speed: t.speed,
    size: t.height > 45 ? "large" : t.height < 30 ? "small" : "normal",
  };
}
function isNormalTraffic(f) { return !f.is_stationary && !f.has_siren && !f.is_erratic && !f.is_fast && !f.is_pedestrian && f.same_side; }

// ---- Traffic signals ----
function initSignals() {
  signals.length = 0;
  for (let i = 1; i <= 8; i++) {
    signals.push({ y: -i * SIGNAL_SPACING, phase: Math.floor(Math.random() * 3), timer: Math.floor(Math.random() * 300) });
  }
}
// Spawn new signals ahead as we drive
function ensureSignals() {
  const furthestY = Math.min(...signals.map(s => s.y));
  if (ego.y - furthestY < SIGNAL_SPACING * 3) {
    signals.push({ y: furthestY - SIGNAL_SPACING, phase: Math.floor(Math.random() * 3), timer: Math.floor(Math.random() * 300) });
  }
  // Remove signals far behind
  for (let i = signals.length - 1; i >= 0; i--) {
    if (signals[i].y > ego.y + 2000) signals.splice(i, 1);
  }
}
function updateSignals() {
  for (const s of signals) {
    s.timer++;
    if (s.timer >= SIGNAL_CYCLE[s.phase].duration) { s.timer = 0; s.phase = (s.phase + 1) % SIGNAL_CYCLE.length; }
    s.state = SIGNAL_CYCLE[s.phase].state;
  }
}
function getNextSignal() {
  // Find the closest signal AHEAD of us (sig.y < ego.y, so dy = ego.y - sig.y > 0)
  let best = null, bestDist = Infinity;
  for (const s of signals) {
    const dy = ego.y - s.y; // positive = signal is ahead
    if (dy > -30 && dy < 500 && dy < bestDist) { bestDist = dy; best = s; }
  }
  return best;
}

// ---- Scan ----
function scanLane(laneIdx, radius) {
  const lx = ourLaneCenter(laneIdx);
  const ahead = [], behind = [];
  for (const t of traffic) {
    if (t.passed || t.damaged || t.isOpposite) continue;
    if (Math.abs(t.x - lx) > LANE_W * 0.6) continue;
    const dy = ego.y - t.y;
    if (dy > 0 && dy < radius) ahead.push({ entity: t, distance: dy });
    else if (dy < 0 && dy > -radius) behind.push({ entity: t, distance: Math.abs(dy) });
  }
  ahead.sort((a, b) => a.distance - b.distance);
  behind.sort((a, b) => a.distance - b.distance);
  return { ahead, behind };
}

// ---- Spawn ----
function isChaos() { return document.getElementById("chaos")?.checked; }
function pickKind() {
  const weights = isChaos() ? CHAOS_WEIGHTS : SPAWN_WEIGHTS;
  const total = weights.reduce((a, b) => a + b.weight, 0);
  let roll = Math.random() * total;
  for (const k of weights) { if (roll < k.weight) return k.kind; roll -= k.weight; }
  return "traffic_car";
}

function spawnTraffic() {
  spawnCounter++;
  if (spawnCounter < SPAWN_INTERVAL) return;
  spawnCounter = 0;
  if (traffic.filter(t => !t.passed).length > 20) return; // moderate traffic for learning

  const kind = pickKind();
  let x, y, speed, w = 28, h = 48;

  if (kind === "opp_traffic") {
    // Opposite direction — spawn multiple cars on the other side for realistic flow
    const count = 2 + Math.floor(Math.random() * 3); // 2-4 cars at once
    for (let c = 0; c < count; c++) {
      const lane = Math.floor(Math.random() * OPP_LANES);
      const ox = oppLaneCenter(lane);
      const oy = ego.y - 300 - Math.random() * 1500; // spread far ahead
      const ospeed = 2 + Math.random() * 2;
      const isAmb = Math.random() < 0.08;
      const ot = new Car(ox, oy, w, h, isAmb ? "opp_ambulance" : "opp_traffic", ospeed);
      ot.isOpposite = true;
      traffic.push(ot);
    }
    return;
  }

  const lane = Math.floor(Math.random() * OUR_LANES);
  const behind = Math.random() < BEHIND_CHANCE && kind !== "obstacle";

  if (kind === "obstacle") {
    y = ego.y - (MIN_SPAWN_DIST + Math.random() * (MAX_SPAWN_DIST - MIN_SPAWN_DIST));
    speed = 0;
  } else if (kind === "auto_rickshaw") {
    y = behind ? ego.y + 150 + Math.random() * BEHIND_DIST : ego.y - (MIN_SPAWN_DIST + Math.random() * MAX_SPAWN_DIST);
    speed = behind ? 3.5 + Math.random() : 1.0 + Math.random() * 1.5;
    w = 22; h = 36;
  } else if (kind === "motorcycle") {
    y = behind ? ego.y + 100 + Math.random() * BEHIND_DIST : ego.y - (MIN_SPAWN_DIST + Math.random() * MAX_SPAWN_DIST);
    speed = behind ? 4 + Math.random() * 1.5 : 2 + Math.random();
    w = 14; h = 30;
  } else if (kind === "ambulance") {
    y = ego.y - (MIN_SPAWN_DIST + Math.random() * MAX_SPAWN_DIST);
    speed = 2 + Math.random() * 0.5;
  } else if (kind === "rash_driver") {
    y = behind ? ego.y + 200 + Math.random() * BEHIND_DIST : ego.y - (MIN_SPAWN_DIST + Math.random() * MAX_SPAWN_DIST);
    speed = behind ? 4 + Math.random() * 1.5 : 1.5 + Math.random();
  } else {
    y = behind ? ego.y + 150 + Math.random() * BEHIND_DIST : ego.y - (MIN_SPAWN_DIST + Math.random() * MAX_SPAWN_DIST);
    speed = behind ? 3.5 + Math.random() * 0.5 : 1.5 + Math.random() * 1.3;
  }

  // Don't spawn on top of existing
  const tooClose = traffic.some(t => !t.passed && Math.abs(t.x - ourLaneCenter(lane)) < 35 && Math.abs(t.y - y) < 120);
  if (tooClose) return;

  const t = new Car(ourLaneCenter(lane), y, w, h, kind, speed);
  if (kind === "rash_driver") { t._rashTimer = 0; t._rashInterval = 50 + Math.floor(Math.random() * 100); }
  traffic.push(t);
  logTo("log-engine", `📡 [RADAR] ${kind} lane=${lane} ${behind ? "↩BEHIND" : "↑AHEAD"} spd=${speed.toFixed(1)}`, "sensor");
}

// ---- Muscle control ----
const currentMode = () => document.getElementById("mode").value;

function getCurrentLane() {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < OUR_LANES; i++) { const d = Math.abs(ego.x - ourLaneCenter(i)); if (d < bestD) { bestD = d; best = i; } }
  return best;
}

// ---- Safety management system ----
// Checks sensor data BEFORE every action to verify it's safe
function safetyCheck(outerScans, innerScans) {
  const rear = innerScans[currentLane].behind;
  const rearThreat = rear.length > 0 && rear[0].distance < 80 && rear[0].entity.speed > ego.speed + 1;
  const frontClear = innerScans[currentLane].ahead.length === 0;
  const closestAhead = innerScans[currentLane].ahead[0];
  const frontDist = closestAhead ? closestAhead.distance : Infinity;
  return { rearThreat, frontClear, frontDist, rearDist: rear.length > 0 ? rear[0].distance : Infinity,
           rearSpeed: rear.length > 0 ? rear[0].entity.speed : 0 };
}

function muscleControl() {
  const mode = currentMode();
  if (!ego || ego.damaged) return;
  ego.forward = true;
  currentLane = getCurrentLane();

  if (mode === "brainer") {
    if (ego.brain_action === "halt") { ego.forward = false; ego.speed *= 0.9; }
    return;
  }

  // ---- SENSOR SCAN (all lanes) ----
  const outerScans = [], innerScans = [];
  for (let i = 0; i < OUR_LANES; i++) { outerScans.push(scanLane(i, OUTER_RADAR)); innerScans.push(scanLane(i, INNER_RADAR)); }
  const safety = safetyCheck(outerScans, innerScans);

  // ---- LANE SCORING ----
  const laneScores = [];
  for (let i = 0; i < OUR_LANES; i++) {
    let sc = 0;
    for (const t of outerScans[i].ahead) { sc += (1 - t.distance / OUTER_RADAR) * 2; const sf = getSensorFeatures(t.entity); if (!isNormalTraffic(sf) && !t.entity.brain_action) sc += 3; }
    for (const t of innerScans[i].ahead) sc += 10;
    for (const t of outerScans[i].behind) { if (t.entity.speed > ego.speed) sc += 1.5; }
    if (i !== currentLane) sc += 0.5;
    laneScores.push(sc);
  }

  let safestLane = currentLane, safestScore = laneScores[currentLane];
  for (let i = 0; i < OUR_LANES; i++) { if (laneScores[i] < safestScore) { safestScore = laneScores[i]; safestLane = i; } }

  // Anti-oscillation
  if (!ego._stuckCtr) ego._stuckCtr = 0;
  if (!ego._lastTgt) ego._lastTgt = currentLane;
  if (safestLane !== ego._lastTgt) { ego._stuckCtr++; ego._lastTgt = safestLane; }
  if (ego._stuckCtr > 8) { safestLane = currentLane; ego.speed = Math.min(ego.maxSpeed * 1.2, ego.speed + 0.3); ego._stuckCtr = 0; }
  if (safestLane === currentLane) ego._stuckCtr = Math.max(0, ego._stuckCtr - 1);

  // ---- LANE NARROWING ----
  const narrowApproach = getApproachingNarrowZone();
  const narrowActive = getActiveNarrowZone();
  if (narrowApproach || narrowActive) {
    if (safestLane === 0) safestLane = 1;
    else if (safestLane === OUR_LANES - 1) safestLane = OUR_LANES - 2;
    if (currentLane === 0) safestLane = 1;
    else if (currentLane === OUR_LANES - 1) safestLane = OUR_LANES - 2;
    if (narrowApproach) ego.speed *= 0.92;
    if (narrowActive && currentLane >= 1 && currentLane <= 3 && !narrowActive._scored) {
      narrowActive._scored = true; score += SC.laneMerge;
      logTo("log-car", `💪 MERGE complete lane→${currentLane} (+${SC.laneMerge})`, "muscle");
    }
  }

  // ---- LANE CHANGE (safety-checked with all 3 sensors) ----
  targetLane = safestLane;
  const targetX = ourLaneCenter(targetLane);
  const dx = targetX - ego.x;
  if (Math.abs(dx) > 3) {
    // Check target lane with RADAR (far) and LIDAR (near)
    const tgtAheadFar = outerScans[targetLane].ahead;
    const tgtAheadNear = innerScans[targetLane].ahead;
    const tgtBehind = innerScans[targetLane].behind;
    // Lateral gap check — any car in the lane change path?
    const lateralClear = !traffic.some(t => {
      if (t.passed||t.damaged||t.isOpposite) return false;
      return Math.abs(t.x - ourLaneCenter(targetLane)) < LANE_W * 0.7 && Math.abs(ego.y - t.y) < 100;
    });
    const rearClear = tgtBehind.length === 0 || tgtBehind[0].distance > 80;
    const frontClear = tgtAheadNear.length === 0;
    // Also check: is current lane safe to stay in? (don't rush into unsafe change)
    const curFrontDist = innerScans[currentLane].ahead.length > 0 ? innerScans[currentLane].ahead[0].distance : Infinity;

    if (frontClear && lateralClear && rearClear) {
      ego.x += dx * 0.025;
      if (frameCount % 60 === 0 && targetLane !== currentLane) {
        const farWarn = tgtAheadFar.length > 0 ? ` radar:${Math.round(tgtAheadFar[0].distance)}px` : " radar:clear";
        logTo("log-car", `💪 LANE ${currentLane}→${targetLane} [lidar:clear${farWarn} rear:${rearClear?"clear":Math.round(tgtBehind[0].distance)+"px"}]`, "muscle");
      }
    } else {
      // Stay in current lane — slow down if something ahead
      const homeX = ourLaneCenter(currentLane);
      ego.x += (homeX - ego.x) * 0.06;
      if (curFrontDist < 100) ego.speed *= 0.85;
      else ego.speed *= 0.92;
      if (frameCount % 60 === 0 && targetLane !== currentLane) {
        logTo("log-car", `⚠ LANE ${currentLane}→${targetLane} BLOCKED [${!frontClear?"front ":""}${!lateralClear?"lateral ":""}${!rearClear?"rear ":""}] holding`, "safety");
      }
    }
  } else { ego.x = targetX; }
  ego.angle *= 0.85;

  // ---- SPEED CONTROL (3-tier sensor-driven) ----
  const aI = innerScans[currentLane].ahead, aO = outerScans[currentLane].ahead;
  if (aI.length > 0) {
    // LIDAR range — close, must react
    const ratio = Math.max(0.25, aI[0].distance / INNER_RADAR);
    ego.speed = Math.min(ego.speed, ego.maxSpeed * ratio);
    if (frameCount % 60 === 0) logTo("log-car", `📡 LIDAR ahead ${Math.round(aI[0].distance)}px → throttle ${(ratio*100).toFixed(0)}%`, "sensor");
  } else if (aO.length > 0) {
    // RADAR range — far, gentle adjustment
    const ratio = Math.max(0.6, aO[0].distance / OUTER_RADAR);
    ego.speed = Math.min(ego.speed, ego.maxSpeed * ratio);
    if (frameCount % 90 === 0) logTo("log-car", `📡 RADAR ahead ${Math.round(aO[0].distance)}px → cruise ${(ratio*100).toFixed(0)}%`, "sensor");
  }
  // Also check: if target lane has close traffic ahead (we might merge into trouble)
  if (targetLane !== currentLane && innerScans[targetLane].ahead.length > 0) {
    const tgtDist = innerScans[targetLane].ahead[0].distance;
    if (tgtDist < 100) ego.speed = Math.min(ego.speed, ego.maxSpeed * 0.5);
  }

  // ---- TRAFFIC SIGNAL (safety-aware) ----
  const sig = getNextSignal();
  if (sig) {
    const sigDist = ego.y - sig.y; // positive = signal is ahead of us
    if (sig.state === "red" && sigDist > 0) {
      // SAFETY: check rear before hard stop — if tailgater behind, brake gently
      if (safety.rearThreat && sigDist > 100) {
        ego.speed *= 0.92; // gentle brake — don't get rear-ended
        if (frameCount % 60 === 0) logTo("log-car", `⚠ RED ahead but rear threat ${Math.round(safety.rearDist)}px spd=${safety.rearSpeed.toFixed(1)} — gentle brake`, "safety");
      } else {
        if (sigDist < 300) ego.speed *= 0.85;
        if (sigDist < 150) ego.speed *= 0.75;
        if (sigDist < 80) { ego.speed = 0; ego.forward = false; }
      }
      if (sigDist < 80 && ego.speed < 0.3) {
        if (frameCount % 90 === 0) logTo("log-car", `💪 STOP at RED [dist=${Math.round(sigDist)}px rear=${Math.round(safety.rearDist)}px]`, "muscle");
      }
    }
    if (sig.state === "yellow" && sigDist > 0) {
      if (sigDist < 200) ego.speed *= 0.85;
      if (sigDist < 60) { ego.speed = 0; ego.forward = false; }
    }
    if (sig.state === "green" && sigDist > 0 && sigDist < 100 && ego.speed < 1) {
      ego.forward = true; // resume after red→green
      if (frameCount % 60 === 0) logTo("log-car", `💪 GREEN — resuming [front=${safety.frontClear?"clear":"blocked"}]`, "muscle");
    }
    // Score signal pass — once per signal
    if (!passedSignals.has(sig)) {
      const pastLine = ego.y - sig.y < -10;
      if (pastLine) {
        passedSignals.add(sig);
        if (sig.state === "green") { signalsObeyed++; score += SC.sigObey; logTo("log-car", `💪 GREEN signal passed (+${SC.sigObey})`, "muscle"); }
        else if (sig.state === "red") { score += SC.sigRun; logTo("log-car", `🚨 RED LIGHT RUN (${SC.sigRun})`, "er"); }
        else if (sig.state === "yellow") { logTo("log-car", `💪 YELLOW crossed — was safe`, "muscle"); }
      }
    }
  }
  updateSignalUI(sig);

  // ---- MUSCLE-FIRST: ambulance yield — pull over briefly, resume ----
  if (mode === "scp" && ego.brain_action === "halt") {
    const isEdge = currentLane === 0 || currentLane === OUR_LANES - 1;
    if (!isEdge) {
      ego.x += (ourLaneCenter(0) - ego.x) * 0.04; // pull to edge
      ego.speed = Math.max(ego.speed * 0.9, 1.0);  // slow to 1.0, not crawl
    } else {
      ego.speed = Math.max(ego.speed * 0.88, 0.8);  // at edge, cruise slowly
    }
  }

  // ---- PERIODIC SENSOR SUMMARY ----
  if (frameCount % 90 === 0) {
    const nearby = traffic.filter(t => !t.passed && !t.damaged && !t.isOpposite && Math.hypot(t.x-ego.x,t.y-ego.y) < RADAR_RANGE);
    logTo("log-car", `📡 SCAN L=${currentLane} spd=${ego.speed.toFixed(1)} near=${nearby.length} rear=${Math.round(safety.rearDist)}px fwd=${Math.round(safety.frontDist)}px`, "sensor");
  }
}

// ---- Classify + escalate (MUSCLE-FIRST) ----
// "In MCP the brain asks. In SCP the muscle asks."
//
// Muscle ALWAYS takes a safe default action IMMEDIATELY.
// Brain is consulted async — fire and forget.
// When brain responds, it may upgrade (halt) or downgrade (ignore) the muscle's default.
// The car NEVER stops to wait for brain. It keeps driving safely.

function muscleDefaultAction(f) {
  // Muscle's reflex: what to do before brain responds
  if (f.has_siren) return "mark_engage";     // siren → yield/avoid, brain confirms halt
  if (f.is_stationary) return "mark_engage";  // obstacle → go around
  if (f.is_erratic) return "mark_engage";     // rash → give space
  return "mark_engage";                       // unknown → cautious avoid
}

function classifyAndEscalate() {
  if (currentMode() !== "scp") return;
  for (const t of traffic) {
    if (t.passed || t.reported || t.damaged) continue;
    if (t.isOpposite) continue;

    const eDist = Math.hypot(t.x - ego.x, t.y - ego.y);
    if (eDist > RADAR_RANGE) continue;

    const f = getSensorFeatures(t);
    if (isNormalTraffic(f)) continue;

    const sensor = eDist <= CAMERA_RANGE ? "CAM" : eDist <= LIDAR_RANGE ? "LDR" : "RDR";

    // STEP 1: Check muscle memory (cache) — instant, $0
    const cached = patternStore.lookup(t);
    if (cached === "halt") { t.brain_action = "halt"; ego.brain_action = "halt"; t.reported = true; ambYielded++; score += SC.ambYield;
      logTo("log-car", `💾 CACHE → yield ${t.entity_id} @${Math.round(eDist)}px ($0)`, "cache"); continue; }
    if (cached === "mark_engage") { t.brain_action = "mark_engage"; t.reported = true; score += 2;
      logTo("log-car", `💾 CACHE → avoid ${t.entity_id} @${Math.round(eDist)}px ($0)`, "cache"); continue; }
    if (cached === "mark_ignore") { t.brain_action = "mark_ignore"; t.reported = true;
      logTo("log-car", `💾 CACHE → ignore ${t.entity_id} @${Math.round(eDist)}px ($0)`, "cache"); continue; }

    // STEP 2: MUSCLE ACTS NOW — safe default, keep driving
    const defAction = muscleDefaultAction(f);
    t.brain_action = defAction;
    t.reported = true;
    logTo("log-car", `💪 MUSCLE → avoid ${t.entity_id} @${Math.round(eDist)}px [${sensor}] ${f.has_siren?"🚨":""}${f.is_stationary?"⚠":""}${f.is_erratic?"⚡":""}`, "muscle");

    // STEP 3: Ask brain async — fire and forget, brain may override
    emit({ type: "reallocation_requested", actuator_id: "car_0", entity_id: t.entity_id, cause: "unclassified_sensor_contact",
      delta_state: { position: [Math.round(t.x), Math.round(t.y)], velocity: [0, Number(t.speed.toFixed(1))],
        is_stationary: f.is_stationary, is_fast: f.is_fast, is_erratic: f.is_erratic, has_siren: f.has_siren,
        is_pedestrian: f.is_pedestrian, same_side: f.same_side, size: f.size } });
    logTo("log-car", `📡→🧠 consulting brain (async)`, "as");
  }
}

// ---- Handle brain ----
function handleServerMessage(pkt) {
  if (pkt.type !== "bulk_assignment") return;
  brainCalls++; totalCost += 0.001;
  for (const intent of pkt.assignments || []) {
    const t = traffic.find(e => e.entity_id === intent.target_entity_id);
    if (intent.type === "halt") {
      ego.brain_action = "halt"; if (t) { t.brain_action = "halt"; patternStore.learn(t, "halt"); ambYielded++; score += SC.ambYield; }
      logTo("log-car", `🧠 BRAIN overrides → halt ${intent.target_entity_id} [~$0.001]`, "brain");
    } else if (intent.type === "mark_engage") {
      if (t) { t.brain_action = "mark_engage"; patternStore.learn(t, "mark_engage"); score += 2; }
      logTo("log-car", `🧠 BRAIN confirms → avoid ${intent.target_entity_id} [~$0.001]`, "brain");
    } else if (intent.type === "mark_ignore") {
      if (t) { t.brain_action = "mark_ignore"; patternStore.learn(t, "mark_ignore"); }
      logTo("log-car", `🧠 BRAIN overrides → ignore ${intent.target_entity_id} [~$0.001]`, "brain");
    }
  }
  logTo("log-car", `ASSIGN ${(pkt.assignments||[]).length} from brain`, "as");
  // Clear halt when the threat entity has passed us or left radar range
  if (ego.brain_action === "halt") {
    const threatStillAhead = traffic.some(t => !t.passed && !t.damaged && t.brain_action === "halt" && t.y < ego.y && Math.hypot(t.x - ego.x, t.y - ego.y) < RADAR_RANGE);
    if (!threatStillAhead) { ego.brain_action = null; logTo("log-car", `💪 HALT cleared — threat passed`, "muscle"); }
  }
}

// ---- World state ----
function snapshotWorld() {
  return { scp_version: SCP_VERSION, timestamp: performance.now(), embodiment_id: embodiment?.embodiment_id || "highway-10lane-v1",
    muscle_mode: currentMode(),
    actuators: [{ actuator_id: "car_0", position: [Math.round(ego.x), Math.round(ego.y)], velocity: [Number(ego.speed.toFixed(1)), Number(ego.angle.toFixed(2))], status: ego.damaged ? "damaged" : ego.brain_action === "halt" ? "halted" : "driving" }],
    entities: traffic.filter(t => !t.passed && !t.damaged && t.reported && !t.brain_action)
      .map(t => { const f = getSensorFeatures(t); return { entity_id: t.entity_id, position: [Math.round(t.x), Math.round(t.y)], velocity: [0, Number(t.speed.toFixed(1))], is_stationary: f.is_stationary, is_fast: f.is_fast, is_erratic: f.is_erratic, has_siren: f.has_siren, is_pedestrian: f.is_pedestrian, same_side: f.same_side, size: f.size }; }),
  };
}

// ---- Step ----
function step() {
  if (paused || !ego) return;
  frameCount++;
  spawnTraffic();
  updateSignals();
  ensureSignals();
  ensureNarrowZones();
  muscleControl();

  // Update traffic + rash behavior + traffic avoids ego
  for (const t of traffic) {
    // ---- OTHER CARS AVOID EGO ----
    // Cars behind us slow down, cars near us steer away
    if (!t.isOpposite && !t.passed && !t.damaged && t.kind !== "obstacle" && t.kind !== "pedestrian") {
      const dxE = t.x - ego.x, dyE = t.y - ego.y;
      const distToEgo = Math.hypot(dxE, dyE);
      // Car approaching from behind (dyE > 0 means car is below/behind ego)
      if (dyE > 0 && dyE < 150 && Math.abs(dxE) < LANE_W * 1.2) {
        if (dyE < 80) {
          // Too close — hard brake to create real gap, then drift to adjacent lane
          t.speed = Math.min(t.speed, 0.3);
          const pushDir = dxE > 0 ? 1 : (dxE < 0 ? -1 : (Math.random() < 0.5 ? 1 : -1));
          const pushLane = Math.round((t.x - OUR_LEFT) / LANE_W) + pushDir;
          if (pushLane >= 0 && pushLane < OUR_LANES && !t._pushedByEgo) {
            t._targetX = ourLaneCenter(pushLane);
            t._pushedByEgo = true;
          }
        } else {
          t.speed = Math.min(t.speed, Math.max(ego.speed * 0.7, 0.5));
        }
      }
      // Car about to collide laterally — steer away (mark as ego-pushed, not erratic)
      if (distToEgo < 80 && Math.abs(dxE) < LANE_W) {
        const pushDir = dxE > 0 ? 1 : -1;
        const pushLane = Math.round((t.x - OUR_LEFT) / LANE_W) + pushDir;
        if (pushLane >= 0 && pushLane < OUR_LANES) {
          t._targetX = ourLaneCenter(pushLane);
          t._pushedByEgo = true; // don't flag this as erratic
        }
      }
    }
    if (t.kind === "rash_driver" && !t.passed) {
      t._rashTimer++; if (t._rashTimer >= t._rashInterval) { t._rashTimer = 0; t._rashInterval = 50 + Math.floor(Math.random()*100);
        let nl = Math.round((t.x - OUR_LEFT) / LANE_W) + (Math.random()<0.5?-1:1); nl = Math.max(0, Math.min(OUR_LANES-1, nl)); t._targetX = ourLaneCenter(nl); }
      if (t._targetX !== undefined) { const td = t._targetX - t.x; if (Math.abs(td) > 2) t.x += td * 0.06; else { t.x = t._targetX; t._targetX = undefined; } }
    }
    if (t.kind === "auto_rickshaw" && !t.passed && isChaos() && Math.random() < 0.005) {
      let nl = Math.round((t.x - OUR_LEFT) / LANE_W) + (Math.random()<0.5?-1:1); nl = Math.max(0, Math.min(OUR_LANES-1, nl)); t._targetX = ourLaneCenter(nl);
    }
    if (t._targetX !== undefined && t.kind === "auto_rickshaw") { const td = t._targetX - t.x; if (Math.abs(td) > 2) t.x += td * 0.04; else { t.x = t._targetX; t._targetX = undefined; } }

    // ALL traffic obeys red/yellow signals — stop BEFORE the line
    if (!t.isOpposite && !t.passed && t.kind !== "obstacle" && t.kind !== "pedestrian") {
      for (const s of signals) {
        const distToSig = t.y - s.y; // positive = car is BELOW signal (hasn't reached it)
        // Car is approaching signal from below (hasn't crossed it yet)
        if (distToSig < 0 && distToSig > -120) {
          if (s.state === "red") {
            // Stop before the line (20px gap)
            if (distToSig > -60) { t.speed = 0; t.forward = false; }
            else { t.speed *= 0.8; }
          } else if (s.state === "yellow" && distToSig > -100) {
            t.speed *= 0.85;
          }
        }
        // Car is waiting at red — resume when green
        if (s.state === "green" && distToSig < 0 && distToSig > -60 && t.speed < 0.5) {
          t.forward = true;
          t.speed = t.maxSpeed * 0.5;
        }
      }
    }

    t.update();
  }

  // Ego movement
  if (ego.forward) { if (ego.speed < ego.maxSpeed) ego.speed += ego.acceleration; }
  if (ego.speed > 0) ego.speed -= ego.friction;
  if (ego.speed < 0) ego.speed = 0;
  ego.y -= ego.speed;
  ego.update();

  // ==== COLLISION AVOIDANCE REFLEX (pure muscle, every frame) ====
  // Like pulling your hand from a hot stove — no brain, instant response.
  // Scans for imminent collision threats and takes emergency action.
  const DANGER_ZONE = 70;   // imminent collision range
  const WARNING_ZONE = 130; // pre-collision awareness range
  for (const t of traffic) {
    if (t.passed || t.damaged || t.isOpposite) continue;
    const dxT = t.x - ego.x, dyT = ego.y - t.y; // dyT positive = ahead
    const dist = Math.hypot(dxT, dyT);
    if (dist > WARNING_ZONE) continue;

    const inOurLane = Math.abs(dxT) < LANE_W * 0.7;
    const isAhead = dyT > 0;

    // DANGER ZONE — emergency evasive action
    if (dist < DANGER_ZONE && inOurLane) {
      if (isAhead) {
        // Entity ahead, too close — try escape lane, else FULL STOP
        const escapeLeft = currentLane > 0 ? !traffic.some(e => !e.passed && !e.damaged && !e.isOpposite && Math.abs(e.x - ourLaneCenter(currentLane - 1)) < LANE_W * 0.6 && Math.abs(ego.y - e.y) < 80) : false;
        const escapeRight = currentLane < OUR_LANES - 1 ? !traffic.some(e => !e.passed && !e.damaged && !e.isOpposite && Math.abs(e.x - ourLaneCenter(currentLane + 1)) < LANE_W * 0.6 && Math.abs(ego.y - e.y) < 80) : false;
        if (escapeLeft) { ego.x += (ourLaneCenter(currentLane - 1) - ego.x) * 0.1; ego.speed *= 0.5; }
        else if (escapeRight) { ego.x += (ourLaneCenter(currentLane + 1) - ego.x) * 0.1; ego.speed *= 0.5; }
        else { ego.speed = 0; ego.forward = false; } // FULL STOP — no escape
        if (frameCount % 30 === 0) logTo("log-car", `🚨 REFLEX ${escapeLeft?"dodge←":escapeRight?"dodge→":"FULL STOP"} — ${t.entity_id} @${Math.round(dist)}px`, "er");
      }
      // Behind threat handled by traffic-avoids-ego (they brake, not us accelerate)
    }
    // WARNING ZONE — preemptive slowdown
    else if (dist < WARNING_ZONE && inOurLane && isAhead) {
      const ratio = dist / WARNING_ZONE;
      ego.speed = Math.min(ego.speed, ego.maxSpeed * Math.max(0.3, ratio));
      if (frameCount % 60 === 0) logTo("log-car", `⚠ REFLEX slow — ${t.entity_id} @${Math.round(dist)}px ahead`, "safety");
    }
  }
  ego.update(); // re-calc polygon after any reflex dodge

  // Collision check (our side only — should rarely trigger now)
  for (const t of traffic) {
    if (t.passed || t.damaged || t.isOpposite) continue;
    if (t.polygon.length && polysIntersect(ego.polygon, t.polygon)) {
      if (!ego.damaged) { ego.damaged = true; collisions++; score += SC.collision;
        logTo("log-car", `💥 COLLISION with ${t.entity_id}`, "er"); }
    }
  }

  distanceDriven += ego.speed * 0.01;
  score += ego.speed * SC.dist;
  classifyAndEscalate();

  // Clean passed traffic
  for (let i = traffic.length - 1; i >= 0; i--) {
    const dy = ego.y - traffic[i].y;
    if (traffic[i].isOpposite && traffic[i].y > ego.y + 1200) { traffic.splice(i, 1); continue; }
    if (!traffic[i].isOpposite && (traffic[i].y > ego.y + 500 || dy > 2000)) { traffic[i].passed = true; traffic.splice(i, 1); }
  }
}

// ---- Render ----
const canvas = document.getElementById("carCanvas");
canvas.width = CANVAS_W;
const ctx = canvas.getContext("2d");

function render() {
  if (!ego) return;
  canvas.height = window.innerHeight;
  ctx.save();
  ctx.translate(0, -ego.y + canvas.height * 0.7);

  // Road surface
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(OUR_LEFT - 5, ego.y - canvas.height, OPP_RIGHT - OUR_LEFT + 10, canvas.height * 2.5);

  // Divider
  ctx.fillStyle = "#f9e2af";
  ctx.fillRect(DIV_LEFT, ego.y - canvas.height, DIVIDER_W, canvas.height * 2.5);

  // Lane lines (our side)
  ctx.setLineDash([20, 20]);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  for (let i = 1; i < OUR_LANES; i++) {
    const x = OUR_LEFT + i * LANE_W;
    ctx.beginPath(); ctx.moveTo(x, ego.y - canvas.height); ctx.lineTo(x, ego.y + canvas.height); ctx.stroke();
  }
  // Opposite side
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  for (let i = 1; i < OPP_LANES; i++) {
    const x = OPP_LEFT + i * LANE_W;
    ctx.beginPath(); ctx.moveTo(x, ego.y - canvas.height); ctx.lineTo(x, ego.y + canvas.height); ctx.stroke();
  }
  ctx.setLineDash([]);

  // Road borders
  ctx.strokeStyle = "white"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(OUR_LEFT, ego.y - canvas.height); ctx.lineTo(OUR_LEFT, ego.y + canvas.height); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(OPP_RIGHT, ego.y - canvas.height); ctx.lineTo(OPP_RIGHT, ego.y + canvas.height); ctx.stroke();

  // Road direction arrows (painted on our side every 400px)
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.font = "bold 20px ui-monospace";
  ctx.textAlign = "center";
  for (let ay = ego.y - canvas.height; ay < ego.y + canvas.height; ay += 400) {
    const roundY = Math.round(ay / 400) * 400;
    for (let i = 0; i < OUR_LANES; i++) {
      ctx.fillText("↑", ourLaneCenter(i), roundY);
    }
    // Opposite direction arrows
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    for (let i = 0; i < OPP_LANES; i++) {
      ctx.fillText("↓", oppLaneCenter(i), roundY);
    }
    ctx.fillStyle = "rgba(255,255,255,0.12)";
  }

  // Lane narrowing zones — orange cones blocking lanes 0 and 4
  for (const z of narrowZones) {
    if (Math.abs(ego.y - z.y) > canvas.height * 1.5) continue;
    const zy = z.y, zLen = z.length;
    // Orange barriers on lane 0 and lane 4 edges
    ctx.fillStyle = "rgba(250,179,135,0.25)";
    ctx.fillRect(OUR_LEFT, zy, LANE_W, zLen);                         // lane 0 blocked
    ctx.fillRect(OUR_LEFT + (OUR_LANES - 1) * LANE_W, zy, LANE_W, zLen); // lane 4 blocked
    // Orange cone markers along the edges
    ctx.fillStyle = "#fab387";
    for (let cy = zy; cy < zy + zLen; cy += 80) {
      ctx.beginPath(); ctx.arc(OUR_LEFT + LANE_W - 4, cy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(OUR_LEFT + (OUR_LANES - 1) * LANE_W + 4, cy, 4, 0, Math.PI * 2); ctx.fill();
    }
    // Merge arrows at entrance
    ctx.fillStyle = "rgba(250,179,135,0.6)";
    ctx.font = "bold 16px ui-monospace"; ctx.textAlign = "center";
    ctx.fillText("→", ourLaneCenter(0), zy + zLen + 30);
    ctx.fillText("←", ourLaneCenter(OUR_LANES - 1), zy + zLen + 30);
  }

  // Traffic signals
  for (const s of signals) {
    const sy = s.y;
    if (Math.abs(ego.y - sy) > canvas.height) continue;
    // Stop line across our lanes
    ctx.fillStyle = s.state === "red" ? "rgba(243,139,168,0.5)" : s.state === "yellow" ? "rgba(249,226,175,0.3)" : "rgba(166,227,161,0.15)";
    ctx.fillRect(OUR_LEFT, sy - 3, OUR_RIGHT - OUR_LEFT, 6);
    // Zebra crossing stripes
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    for (let zx = OUR_LEFT; zx < OUR_RIGHT; zx += 16) {
      ctx.fillRect(zx, sy - 15, 8, 12);
    }
    // Signal pole + 3 lights
    ctx.fillStyle = "#1e2030";
    ctx.fillRect(OUR_LEFT - 20, sy - 22, 14, 44);
    const lights = [
      { cy: sy - 14, color: s.state === "red" ? "#f38ba8" : "#3a3a3a" },
      { cy: sy, color: s.state === "yellow" ? "#f9e2af" : "#3a3a3a" },
      { cy: sy + 14, color: s.state === "green" ? "#a6e3a1" : "#3a3a3a" },
    ];
    for (const l of lights) {
      ctx.fillStyle = l.color;
      ctx.beginPath(); ctx.arc(OUR_LEFT - 13, l.cy, 5, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Traffic
  for (const t of traffic) { if (!t.passed) t.draw(ctx); }

  // Sensor zones
  ctx.save();
  // Radar
  ctx.strokeStyle = "rgba(166,227,161,0.15)"; ctx.setLineDash([6,8]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(ego.x, ego.y, RADAR_RANGE, 0, Math.PI*2); ctx.stroke();
  // LiDAR
  ctx.strokeStyle = "rgba(116,199,236,0.2)"; ctx.setLineDash([4,4]);
  ctx.beginPath(); ctx.arc(ego.x, ego.y, LIDAR_RANGE, 0, Math.PI*2); ctx.stroke();
  // Camera cone
  ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(ego.x, ego.y);
  ctx.arc(ego.x, ego.y, CAMERA_RANGE, -Math.PI/2 - CAMERA_FOV/2, -Math.PI/2 + CAMERA_FOV/2);
  ctx.closePath(); ctx.fillStyle = "rgba(249,226,175,0.05)"; ctx.fill();
  ctx.strokeStyle = "rgba(249,226,175,0.2)"; ctx.stroke();

  // Blips
  for (const t of traffic) {
    if (t.passed || t.damaged) continue;
    const dist = Math.hypot(t.x - ego.x, t.y - ego.y);
    if (dist > RADAR_RANGE) continue;
    const f = getSensorFeatures(t);
    if (t.isOpposite) continue; // don't draw sensor blips for opposite traffic — they're background
    let col = f.has_siren ? "rgba(243,139,168,0.8)" : f.is_stationary ? "rgba(249,226,175,0.8)" : "rgba(166,227,161,0.4)";
    const p = 2.5 + Math.sin(performance.now()/200 + dist) * 1.5;
    ctx.beginPath(); ctx.arc(t.x, t.y, p, 0, Math.PI*2); ctx.fillStyle = col; ctx.fill();
  }
  ctx.restore();

  // Ego
  ego.draw(ctx);
  ctx.fillStyle = "#89b4fa"; ctx.beginPath();
  ctx.moveTo(ego.polygon[0].x, ego.polygon[0].y);
  for (let i=1;i<ego.polygon.length;i++) ctx.lineTo(ego.polygon[i].x, ego.polygon[i].y);
  ctx.fill();

  ctx.restore();

  // HUD
  if (sessionStartTs > 0) {
    elapsedMs = paused ? elapsedMs : (performance.now() - sessionStartTs);
    const sec = Math.floor(elapsedMs/1000); const m = Math.floor(sec/60); const s = sec%60;
    ctx.fillStyle = "rgba(11,14,20,0.7)"; ctx.fillRect(0,0,CANVAS_W,28);
    ctx.font = "bold 14px ui-monospace"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#f9e2af"; ctx.textAlign = "center";
    ctx.fillText(`${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`, CANVAS_W/2, 15);
    ctx.fillStyle = "#cba6f7"; ctx.textAlign = "left"; ctx.fillText(`MODEL:${brainCalls}`, 8, 15);
    const cs = patternStore.stats();
    ctx.fillStyle = "#a6e3a1"; ctx.textAlign = "right"; ctx.fillText(`CACHE:${cs.hits}`, CANVAS_W-8, 15);
  }
}

// ---- Signal UI ----
function updateSignalUI(sig) {
  const el = document.getElementById("sig-light");
  const txt = document.getElementById("sig-text");
  if (!sig) { el.className = "sig green"; txt.textContent = "NO SIGNAL"; return; }
  el.className = `sig ${sig.state}`;
  txt.textContent = sig.state.toUpperCase();
}

// ---- Metrics ----
let lastFpsTs = performance.now(), fpsFrames = 0, displayFps = 60;
function updateMetrics() {
  const now = performance.now();
  fpsFrames++;
  if (now - lastFpsTs >= 500) { displayFps = Math.round(fpsFrames*1000/(now-lastFpsTs)); fpsFrames=0; lastFpsTs=now; }
  document.getElementById("m-score").textContent = Math.round(score);
  document.getElementById("m-dist").textContent = Math.round(distanceDriven) + "m";
  document.getElementById("m-speed").textContent = ego ? ego.speed.toFixed(1) : "0";
  document.getElementById("m-collisions").textContent = collisions;
  document.getElementById("m-signals").textContent = signalsObeyed;
  document.getElementById("m-bcm").textContent = brainCalls;
  document.getElementById("m-yields").textContent = ambYielded;
  document.getElementById("m-peds").textContent = pedStops;
  document.getElementById("m-fps").textContent = displayFps;
  document.getElementById("m-lane").textContent = currentLane;
  document.getElementById("m-cost").textContent = `$${totalCost.toFixed(3)}`;
  const cs = patternStore.stats();
  document.getElementById("m-cache").textContent = `${cs.hits}h/${cs.misses}m`;
  if (frameCount % 300 === 0) patternStore.save();
}

// ---- WebSocket ----
function connectWs() {
  try { ws = new WebSocket(WS_URL); } catch { setTimeout(connectWs, 1500); return; }
  ws.onopen = () => { wsConnected = true; document.getElementById("ws").className = "ws up"; document.getElementById("ws").textContent = "WS: on";
    fetch("./embodiment.json").then(r=>r.json()).then(emb => { embodiment = emb; ws.send(JSON.stringify({type:"register_embodiment",scp_version:SCP_VERSION,embodiment}));
      logTo("log-engine", `Registered ${emb.label}`, "ev"); }); };
  ws.onclose = () => { wsConnected = false; document.getElementById("ws").className = "ws down"; document.getElementById("ws").textContent = "WS: off"; setTimeout(connectWs, 1500); };
  ws.onerror = () => {};
  ws.onmessage = (msg) => { let p; try { p = JSON.parse(msg.data); } catch { return; } handleServerMessage(p); };
}
let lastWP = 0;
function pushWS(now) { if (!wsConnected||!ego) return; if (now-lastWP<300) return; lastWP=now;
  ws.send(JSON.stringify({type:"world_state",scp_version:SCP_VERSION,mode:currentMode(),world:snapshotWorld()})); }
function emit(ev) { if (!wsConnected) return;
  ws.send(JSON.stringify({type:"semantic_event",scp_version:SCP_VERSION,event:{...ev,event_id:`e_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,scp_version:SCP_VERSION,timestamp:performance.now()}})); }

// ---- Logging ----
function logTo(id, msg, cls="") { const el=document.getElementById(id); if(!el) return; const d=document.createElement("div"); d.className=cls; d.textContent=`[${(performance.now()/1000).toFixed(1)}s] ${msg}`; el.appendChild(d); el.scrollTop=el.scrollHeight; while(el.children.length>200) el.removeChild(el.firstChild); }

// ---- Main loop ----
function animate() { step(); if(ego){pushWS(performance.now());render();} updateMetrics(); requestAnimationFrame(animate); }

// ---- Controls ----
function setPaused(p) { paused=p; document.getElementById("playpause").textContent=paused?"▶ Play":"⏸ Pause"; if(!paused&&sessionStartTs===0)sessionStartTs=performance.now(); }
document.getElementById("playpause").addEventListener("click",()=>setPaused(!paused));
document.addEventListener("keydown",e=>{if(e.code==="Space"){e.preventDefault();setPaused(!paused);}});
document.getElementById("reset").addEventListener("click",()=>{
  traffic.length=0; score=0; distanceDriven=0; collisions=0; signalsObeyed=0; ambYielded=0; pedStops=0; brainCalls=0; totalCost=0;
  frameCount=0; spawnCounter=0; sessionStartTs=0; elapsedMs=0; passedSignals.clear(); initEgo(); initSignals(); initNarrowZones();
  logTo("log-engine","RESET","ev");
});
document.getElementById("mode").addEventListener("change",e=>logTo("log-engine",`MODE = ${e.target.value}`,"as"));

// ---- Boot ----
initEgo(); initSignals(); initNarrowZones(); patternStore.load(); connectWs(); setPaused(true); requestAnimationFrame(animate);
