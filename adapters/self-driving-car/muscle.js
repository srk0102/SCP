// SCP Self-Driving Car Adapter (Adapter #2)
// ==========================================
// Car physics + sensor from gniziemazity/Self-driving-car (Phase 5, MIT)
// SCP muscle layer + 3-mode control + pattern store = ours
//
// ZERO changes to: schema, MCP server, WS bridge, bridge.
// Same protocol, same brain (Nova Micro), different body.

import { patternStore } from "./pattern-store.js";

const SCP_VERSION = "0.1.0";
const WS_URL = "ws://localhost:7777";

// ---------- Road geometry ----------
const CANVAS_W = 300;
const ROAD_W = 260;
const LANE_COUNT = 3;

// ---------- Entity types ----------
// traffic_car: muscle avoids (no brain)
// ambulance: brain must classify → halt (pull over)
// obstacle: brain must classify → mark_engage (swerve)
const ENTITY_KINDS = {
  traffic_car:  { color: "#a6adc8", label: "traffic" },
  rash_driver:  { color: "#f5c2e7", label: "🏎 rash driver" },   // changes lanes randomly
  ambulance:    { color: "#f38ba8", label: "🚑 ambulance" },
  obstacle:     { color: "#fab387", label: "⚠ obstacle" },
};

const SPAWN_INTERVAL = 140; // frames between spawns (~2.3 seconds — busy road)
const MIN_SPAWN_DISTANCE = 600;  // spawn window
const MAX_SPAWN_DISTANCE = 1400;
const BEHIND_SPAWN_CHANCE = 0.3; // 30% chance traffic spawns BEHIND us (same direction, faster)
const BEHIND_SPAWN_DIST = 400;   // how far behind
const SPAWN_WEIGHTS = [
  { kind: "traffic_car", weight: 40 },
  { kind: "rash_driver", weight: 25 },  // Indian chaos
  { kind: "ambulance", weight: 20 },
  { kind: "obstacle", weight: 15 },
];

// ---------- Scoring ----------
const SCORE = {
  distance: 0.01,
  ambulance_yield: 5,
  obstacle_avoided: 2,
  collision: -10,
  ambulance_ignored: -5,
};

// ---------- State ----------
let embodiment = null;
let ws = null;
let wsConnected = false;
let paused = true;
let sessionStartTs = 0;
let elapsedMs = 0;
let frameCount = 0;

let score = 0;
let distanceDriven = 0;
let collisions = 0;
let ambulancesYielded = 0;
let ambulancesIgnored = 0;
let obstaclesAvoided = 0;
let brainCalls = 0;

// ---------- Utility functions (from gniziemazity) ----------
function lerp(A, B, t) { return A + (B - A) * t; }

function getIntersection(A, B, C, D) {
  const tTop = (D.x - C.x) * (A.y - C.y) - (D.y - C.y) * (A.x - C.x);
  const uTop = (C.y - A.y) * (A.x - B.x) - (C.x - A.x) * (A.y - B.y);
  const bottom = (D.y - C.y) * (B.x - A.x) - (D.x - C.x) * (B.y - A.y);
  if (bottom !== 0) {
    const t = tTop / bottom;
    const u = uTop / bottom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return { x: lerp(A.x, B.x, t), y: lerp(A.y, B.y, t), offset: t };
    }
  }
  return null;
}

function polysIntersect(p1, p2) {
  for (let i = 0; i < p1.length; i++) {
    for (let j = 0; j < p2.length; j++) {
      const touch = getIntersection(
        p1[i], p1[(i + 1) % p1.length],
        p2[j], p2[(j + 1) % p2.length]
      );
      if (touch) return true;
    }
  }
  return false;
}

// ---------- Road ----------
class Road {
  constructor(x, width, laneCount = 3) {
    this.x = x;
    this.width = width;
    this.laneCount = laneCount;
    this.left = x - width / 2;
    this.right = x + width / 2;
    const inf = 1000000;
    this.top = -inf;
    this.bottom = inf;
    const topLeft = { x: this.left, y: this.top };
    const topRight = { x: this.right, y: this.top };
    const bottomLeft = { x: this.left, y: this.bottom };
    const bottomRight = { x: this.right, y: this.bottom };
    this.borders = [[topLeft, bottomLeft], [topRight, bottomRight]];
  }
  getLaneCenter(i) {
    const laneWidth = this.width / this.laneCount;
    return this.left + laneWidth / 2 + Math.min(i, this.laneCount - 1) * laneWidth;
  }
  draw(ctx) {
    ctx.lineWidth = 5;
    ctx.strokeStyle = "white";
    for (let i = 1; i < this.laneCount; i++) {
      const x = lerp(this.left, this.right, i / this.laneCount);
      ctx.setLineDash([20, 20]);
      ctx.beginPath();
      ctx.moveTo(x, this.top);
      ctx.lineTo(x, this.bottom);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const border of this.borders) {
      ctx.beginPath();
      ctx.moveTo(border[0].x, border[0].y);
      ctx.lineTo(border[1].x, border[1].y);
      ctx.stroke();
    }
  }
}

// ---------- Sensor (5-ray, from gniziemazity) ----------
class Sensor {
  constructor(car) {
    this.car = car;
    this.rayCount = 9;
    this.rayLength = 200;
    this.raySpread = Math.PI * 0.75; // 135° — sees full road width + 10m ahead
    this.rays = [];
    this.readings = [];
  }
  update(roadBorders, traffic) {
    this.rays = [];
    for (let i = 0; i < this.rayCount; i++) {
      const rayAngle = lerp(this.raySpread / 2, -this.raySpread / 2, this.rayCount === 1 ? 0.5 : i / (this.rayCount - 1)) + this.car.angle;
      const start = { x: this.car.x, y: this.car.y };
      const end = { x: this.car.x - Math.sin(rayAngle) * this.rayLength, y: this.car.y - Math.cos(rayAngle) * this.rayLength };
      this.rays.push([start, end]);
    }
    this.readings = [];
    for (const ray of this.rays) {
      this.readings.push(this._getReading(ray, roadBorders, traffic));
    }
  }
  _getReading(ray, roadBorders, traffic) {
    let touches = [];
    for (const border of roadBorders) {
      const touch = getIntersection(ray[0], ray[1], border[0], border[1]);
      if (touch) touches.push(touch);
    }
    for (const t of traffic) {
      if (!t.polygon) continue;
      for (let j = 0; j < t.polygon.length; j++) {
        const v = getIntersection(ray[0], ray[1], t.polygon[j], t.polygon[(j + 1) % t.polygon.length]);
        if (v) touches.push({ ...v, entityRef: t });
      }
    }
    if (!touches.length) return null;
    const offsets = touches.map(e => e.offset);
    const minOff = Math.min(...offsets);
    return touches.find(e => e.offset === minOff);
  }
  draw(ctx) {
    for (let i = 0; i < this.rayCount; i++) {
      let end = this.rays[i][1];
      if (this.readings[i]) end = this.readings[i];
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "yellow";
      ctx.moveTo(this.rays[i][0].x, this.rays[i][0].y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "black";
      ctx.moveTo(this.rays[i][1].x, this.rays[i][1].y);
      ctx.lineTo(end.x, end.y);
      ctx.stroke();
    }
  }
}

// ---------- Car (adapted from gniziemazity + SCP controls) ----------
class Car {
  constructor(x, y, width, height, kind = "ego", maxSpeed = 3) {
    this.x = x; this.y = y;
    this.width = width; this.height = height;
    this.kind = kind;
    this.entity_id = kind === "ego" ? "car_0" : `${kind}_${Math.random().toString(36).slice(2, 6)}`;
    this.speed = 0;
    this.acceleration = 0.2;
    this.maxSpeed = maxSpeed;
    this.friction = 0.05;
    this.angle = 0;
    this.damaged = false;
    this.polygon = [];
    // SCP state
    this.brain_action = null;       // "halt" | "mark_engage" | "mark_ignore" | null
    this.brain_target_id = null;
    this.reported = false;
    this.passed = false;            // has the ego car driven past this entity?
    // Controls
    this.forward = kind !== "obstacle";
    this.reverse = false;
    this.left = false;
    this.right = false;
    // Sensor (ego only)
    this.sensor = kind === "ego" ? new Sensor(this) : null;
  }

  update(roadBorders, traffic) {
    if (!this.damaged) {
      this._move();
      this.polygon = this._createPolygon();
      if (this.kind === "ego") {
        this.damaged = this._assessDamage(roadBorders, traffic);
      }
    }
    if (this.sensor) this.sensor.update(roadBorders, traffic);
  }

  _assessDamage(roadBorders, traffic) {
    for (let i = 0; i < roadBorders.length; i++) {
      if (polysIntersect(this.polygon, roadBorders[i])) {
        console.log(`COLLISION: road border ${i} (x=${i === 0 ? road.left : road.right}) car.x=${this.x.toFixed(0)} car.y=${this.y.toFixed(0)} angle=${this.angle.toFixed(3)}`);
        return true;
      }
    }
    for (const t of traffic) {
      if (!t.polygon || t.passed) continue;
      if (polysIntersect(this.polygon, t.polygon)) {
        const dy = Math.round(this.y - t.y);
        console.log(`COLLISION: ${t.kind} ${t.entity_id} at x=${t.x.toFixed(0)} y=${t.y.toFixed(0)} car.x=${this.x.toFixed(0)} car.y=${this.y.toFixed(0)} dy=${dy} lane_car=${getCurrentLane()} t.speed=${t.speed}`);
        return true;
      }
    }
    return false;
  }

  _createPolygon() {
    const points = [];
    const rad = Math.hypot(this.width, this.height) / 2;
    const alpha = Math.atan2(this.width, this.height);
    points.push({ x: this.x - Math.sin(this.angle - alpha) * rad, y: this.y - Math.cos(this.angle - alpha) * rad });
    points.push({ x: this.x - Math.sin(this.angle + alpha) * rad, y: this.y - Math.cos(this.angle + alpha) * rad });
    points.push({ x: this.x - Math.sin(Math.PI + this.angle - alpha) * rad, y: this.y - Math.cos(Math.PI + this.angle - alpha) * rad });
    points.push({ x: this.x - Math.sin(Math.PI + this.angle + alpha) * rad, y: this.y - Math.cos(Math.PI + this.angle + alpha) * rad });
    return points;
  }

  _move() {
    if (this.forward) this.speed += this.acceleration;
    if (this.reverse) this.speed -= this.acceleration;
    if (this.speed > this.maxSpeed) this.speed = this.maxSpeed;
    if (this.speed < -this.maxSpeed / 2) this.speed = -this.maxSpeed / 2;
    if (this.speed > 0) this.speed -= this.friction;
    if (this.speed < 0) this.speed += this.friction;
    if (Math.abs(this.speed) < this.friction) this.speed = 0;
    if (this.speed !== 0) {
      const flip = this.speed > 0 ? 1 : -1;
      if (this.left) this.angle += 0.03 * flip;
      if (this.right) this.angle -= 0.03 * flip;
    }
    this.x -= Math.sin(this.angle) * this.speed;
    this.y -= Math.cos(this.angle) * this.speed;
  }

  draw(ctx, color) {
    ctx.fillStyle = this.damaged ? "gray" : color;
    ctx.beginPath();
    ctx.moveTo(this.polygon[0].x, this.polygon[0].y);
    for (let i = 1; i < this.polygon.length; i++) ctx.lineTo(this.polygon[i].x, this.polygon[i].y);
    ctx.fill();
    // Kind label for non-ego
    if (this.kind === "ambulance") {
      ctx.fillStyle = "#fff";
      ctx.font = "bold 12px ui-monospace";
      ctx.textAlign = "center";
      ctx.fillText("🚑", this.x, this.y + 4);
    }
    if (this.kind === "obstacle") {
      ctx.fillStyle = "#fff";
      ctx.font = "10px ui-monospace";
      ctx.textAlign = "center";
      ctx.fillText("⚠", this.x, this.y + 4);
    }
    if (this.sensor) this.sensor.draw(ctx);
  }
}

// ---------- Main simulation ----------
const canvas = document.getElementById("carCanvas");
canvas.width = CANVAS_W;
const ctx = canvas.getContext("2d");

const road = new Road(canvas.width / 2, ROAD_W, LANE_COUNT);
let ego = null;
const traffic = [];
let spawnCounter = 0;

function initEgo() {
  ego = new Car(road.getLaneCenter(1), 100, 30, 50, "ego", 3);
  ego.update(road.borders, []); // populate polygon so it renders even when paused
}

function pickKind() {
  const total = SPAWN_WEIGHTS.reduce((a, b) => a + b.weight, 0);
  let roll = Math.random() * total;
  for (const k of SPAWN_WEIGHTS) {
    if (roll < k.weight) return k.kind;
    roll -= k.weight;
  }
  return SPAWN_WEIGHTS[0].kind;
}

function spawnTraffic() {
  spawnCounter++;
  if (spawnCounter < SPAWN_INTERVAL) return;
  spawnCounter = 0;

  if (traffic.filter(t => !t.passed).length > 12) return;

  const kind = pickKind();
  const lane = Math.floor(Math.random() * LANE_COUNT);

  // Spawn ahead OR behind (cars behind us = they're faster, approaching from rear)
  let spawnY, speed, spawnBehind = false;

  if (kind === "obstacle") {
    // Obstacle: stationary, always ahead, far away
    spawnY = ego.y - (MIN_SPAWN_DISTANCE + Math.random() * (MAX_SPAWN_DISTANCE - MIN_SPAWN_DISTANCE));
    speed = 0;
  } else if (kind === "rash_driver") {
    // Rash driver: fast, might come from behind, changes lanes
    spawnBehind = Math.random() < 0.5;
    if (spawnBehind) {
      spawnY = ego.y + 200 + Math.random() * BEHIND_SPAWN_DIST;
      speed = 3.5 + Math.random() * 1.5; // faster than us! (3.5-5.0)
    } else {
      spawnY = ego.y - (MIN_SPAWN_DISTANCE + Math.random() * (MAX_SPAWN_DISTANCE - MIN_SPAWN_DISTANCE));
      speed = 1.0 + Math.random() * 1.5; // slow rash driver ahead (we catch up)
    }
  } else if (kind === "ambulance") {
    // Ambulance: ahead, moderate speed
    spawnY = ego.y - (MIN_SPAWN_DISTANCE + Math.random() * (MAX_SPAWN_DISTANCE - MIN_SPAWN_DISTANCE));
    speed = 2.0 + Math.random() * 0.5;
  } else {
    // Traffic car: some ahead (slower), some behind (faster, catching up)
    spawnBehind = Math.random() < BEHIND_SPAWN_CHANCE;
    if (spawnBehind) {
      spawnY = ego.y + 150 + Math.random() * BEHIND_SPAWN_DIST;
      speed = 3.2 + Math.random() * 0.8; // faster than us (3.2-4.0)
    } else {
      spawnY = ego.y - (MIN_SPAWN_DISTANCE + Math.random() * (MAX_SPAWN_DISTANCE - MIN_SPAWN_DISTANCE));
      speed = 1.5 + Math.random() * 1.3; // slower (1.5-2.8)
    }
  }

  // Don't spawn ON TOP of existing traffic
  const tooClose = traffic.some(t =>
    !t.passed && Math.abs(t.x - road.getLaneCenter(lane)) < 40 &&
    Math.abs(t.y - spawnY) < 150
  );
  if (tooClose) return;

  const t = new Car(road.getLaneCenter(lane), spawnY, 30, 50, kind, speed);
  t.entity_id = `${kind}_${Math.floor(Math.random() * 10000)}`;

  // Rash drivers change lanes randomly
  // Physical properties set at spawn (these are OBSERVABLE, not labels)
  if (kind === "rash_driver") {
    t._rashTimer = 0;
    t._rashInterval = 60 + Math.floor(Math.random() * 120);
  }
  if (kind === "ambulance") {
    t._hasSiren = true;  // audio sensor can detect this — it's a physical signal
  }

  traffic.push(t);
  // Sensor-attributed detection log (which sensor would see it first)
  const sFeatures = getSensorFeatures(t);
  const dist = spawnBehind ? BEHIND_SPAWN_DIST : Math.round(MIN_SPAWN_DISTANCE + (MAX_SPAWN_DISTANCE - MIN_SPAWN_DISTANCE) / 2);
  let sensor = "RADAR";
  if (dist <= LIDAR_RANGE) sensor = "LiDAR";
  if (dist <= CAMERA_RANGE && !spawnBehind) sensor = "CAMERA";
  log(`📡 [${sensor}] contact lane=${lane} ${spawnBehind ? "↩BEHIND" : "↑AHEAD"} spd=${speed.toFixed(1)} ${sFeatures.has_siren ? "🚨SIREN " : ""}${sFeatures.is_stationary ? "⚠STATIC " : ""}${sFeatures.is_erratic ? "⚡ERRATIC " : ""}`, "ev");
}

// ---------- SCP Muscle logic ----------
const currentMode = () => document.getElementById("mode").value;

// Real sensor layers (scaled to canvas)
const LIDAR_RANGE = 160;   // 8m — 360° point cloud, sees position of everything, can't classify
const RADAR_RANGE = 250;   // 12m — front+rear cones, detects speed/distance, no shape
const CAMERA_RANGE = 140;  // 7m — forward only ~120°, sees shape/siren/color
const CAMERA_FOV = Math.PI * 0.65; // 117° forward cone

// Keep backward compat names for driving logic
const OUTER_RADAR = RADAR_RANGE;
const INNER_RADAR = LIDAR_RANGE;

let currentLane = 1;      // ego's current lane (0, 1, 2)
let targetLane = 1;       // lane the muscle is steering toward
let laneChangeActive = false;

function getCurrentLane() {
  // Determine which lane the car is closest to
  let bestLane = 0;
  let bestDist = Infinity;
  for (let i = 0; i < LANE_COUNT; i++) {
    const d = Math.abs(ego.x - road.getLaneCenter(i));
    if (d < bestDist) { bestDist = d; bestLane = i; }
  }
  return bestLane;
}

// Scan a specific lane for threats — 360 degree awareness
// Returns { ahead: [...], behind: [...] } with signed distances
function scanLane(laneIndex, radius) {
  const laneX = road.getLaneCenter(laneIndex);
  const laneWidth = road.width / LANE_COUNT;
  const ahead = [];
  const behind = [];
  for (const t of traffic) {
    if (t.passed || t.damaged) continue;
    if (Math.abs(t.x - laneX) > laneWidth * 0.6) continue;
    const dy = ego.y - t.y; // positive = ahead, negative = behind
    if (dy > 0 && dy < radius) {
      ahead.push({ entity: t, distance: dy });
    } else if (dy < 0 && dy > -radius) {
      behind.push({ entity: t, distance: Math.abs(dy) });
    }
  }
  ahead.sort((a, b) => a.distance - b.distance);
  behind.sort((a, b) => a.distance - b.distance);
  return { ahead, behind, all: [...ahead, ...behind] };
}

// Quick helper: count threats ahead (backward compat for lane scoring)
function scanLaneAhead(laneIndex, radius) {
  return scanLane(laneIndex, radius).ahead;
}

function muscleControl() {
  const mode = currentMode();
  if (!ego || ego.damaged) return;

  // Reset controls
  ego.forward = true;
  ego.left = false;
  ego.right = false;

  // Brainer: no local autonomy. Car drives straight. Brain is too slow → crashes.
  if (mode === "brainer") {
    if (ego.brain_action === "halt") {
      ego.forward = false;
      ego.speed *= 0.9;
    }
    return;
  }

  currentLane = getCurrentLane();

  // ---- STEP 1: Scan all lanes at OUTER radar (planning) ----
  const outerScans = [];
  for (let i = 0; i < LANE_COUNT; i++) {
    outerScans.push(scanLane(i, OUTER_RADAR));
  }

  // ---- STEP 2: Scan all lanes at INNER radar (action) ----
  const innerScans = [];
  for (let i = 0; i < LANE_COUNT; i++) {
    innerScans.push(scanLane(i, INNER_RADAR));
  }

  // ---- STEP 3: Check for abnormal entities in outer radar → escalate immediately ----
  // (handled by classifyAndEscalate, not here — muscle just plans lanes)

  // ---- STEP 4: Determine safest lane (360° scan — ahead + behind) ----
  const laneScores = [];
  for (let i = 0; i < LANE_COUNT; i++) {
    let score = 0;
    for (const t of outerScans[i].ahead) {
      const urgency = 1 - (t.distance / OUTER_RADAR);
      score += urgency * 2;
      const sf = getSensorFeatures(t.entity);
      if (!isNormalTraffic(sf) && !t.entity.brain_action) score += 3;
    }
    for (const t of innerScans[i].ahead) score += 10;
    // Penalize lanes with fast traffic BEHIND (they'll box us in)
    for (const t of outerScans[i].behind) {
      if (t.entity.speed > ego.speed) score += 1.5;
    }
    if (i !== currentLane) score += 0.5;
    laneScores.push(score);
  }

  let safestLane = currentLane;
  let safestScore = laneScores[currentLane];
  for (let i = 0; i < LANE_COUNT; i++) {
    if (laneScores[i] < safestScore) { safestScore = laneScores[i]; safestLane = i; }
  }

  // ---- STEP 4b: ANTI-OSCILLATION ----
  if (!ego._stuckCounter) ego._stuckCounter = 0;
  if (!ego._lastTarget) ego._lastTarget = currentLane;
  if (safestLane !== ego._lastTarget) { ego._stuckCounter++; ego._lastTarget = safestLane; }
  if (ego._stuckCounter > 8) {
    safestLane = currentLane;
    ego.speed = Math.min(ego.maxSpeed * 1.2, ego.speed + 0.3);
    ego._stuckCounter = 0;
    if (frameCount % 30 === 0) log(`⚡ ANTI-OSCILLATION — holding lane ${currentLane}, accelerating`, "as");
  }
  if (safestLane === currentLane && Math.abs(road.getLaneCenter(currentLane) - ego.x) < 5) {
    ego._stuckCounter = Math.max(0, ego._stuckCounter - 1);
  }

  // LOG (360° aware)
  if (frameCount % 30 === 0) {
    const iA = innerScans.map(s => s.ahead.length);
    const iB = innerScans.map(s => s.behind.length);
    const oInfo = outerScans.map(s => {
      const a = s.ahead.map(t => {
        const sf = getSensorFeatures(t.entity);
        return `${sf.has_siren?"🚨":sf.is_stationary?"⚠":sf.is_erratic?"⚡":"🚗"}@${Math.round(t.distance)}`;
      }).join(",") || "clear";
      return a + (s.behind.length ? ` [${s.behind.length}↩]` : "");
    });
    log(`🛣 L=${currentLane}→${safestLane} sc=[${laneScores.map(s=>s.toFixed(1))}] fwd=[${iA}] rear=[${iB}] out=[${oInfo}] spd=${ego.speed.toFixed(1)}`, "ev");
  }

  // ---- STEP 5: ALL lanes blocked (chaos) ----
  const allBlocked = innerScans.every(s => s.ahead.length > 0);
  if (allBlocked) {
    ego.speed *= 0.7;
    if (mode === "scp" && !ego._chaosReported) {
      ego._chaosReported = true;
      emit({ type: "reallocation_requested", actuator_id: "car_0", cause: "all_lanes_blocked",
        delta_state: { ahead: innerScans.map(s => s.ahead.length), behind: innerScans.map(s => s.behind.length) } });
      log("⬆ CHAOS — all lanes blocked", "er");
      setTimeout(() => { ego._chaosReported = false; }, 3000);
    }
  }

  // ---- STEP 6: Lane change with LATERAL + REAR validation ----
  targetLane = safestLane;
  const targetX = road.getLaneCenter(targetLane);
  const dx = targetX - ego.x;

  if (Math.abs(dx) > 3) {
    const lateralClear = !traffic.some(t => {
      if (t.passed || t.damaged) return false;
      return Math.abs(t.x - (ego.x + dx * 0.025)) < 40 && Math.abs(ego.y - t.y) < 80;
    });
    const rearClear = innerScans[targetLane].behind.length === 0 ||
      innerScans[targetLane].behind[0].distance > 60;

    if (innerScans[targetLane].ahead.length === 0 && lateralClear && rearClear) {
      ego.x += dx * 0.025;
      laneChangeActive = true;
      if (frameCount % 15 === 0) log(`↔ LANE ${currentLane}→${targetLane} dx=${Math.round(dx)}`, "ev");
    } else {
      // BLOCKED — snap BACK to current lane center (anti-jitter)
      const homeX = road.getLaneCenter(currentLane);
      ego.x += (homeX - ego.x) * 0.06;
      ego.speed *= 0.88;
      laneChangeActive = false;
      const why = !lateralClear ? "lateral" : !rearClear ? "rear" : "ahead";
      if (frameCount % 30 === 0) log(`🚫 LANE ${targetLane} BLOCKED (${why}) — holding ${currentLane}`, "er");
    }
  } else {
    ego.x = targetX;
    laneChangeActive = false;
  }

  ego.angle *= 0.85;

  // ---- STEP 7: Speed control ----
  const aheadInner = innerScans[currentLane].ahead;
  const aheadOuter = outerScans[currentLane].ahead;
  if (aheadInner.length > 0) {
    const closest = aheadInner[0].distance;
    ego.speed = Math.min(ego.speed, ego.maxSpeed * Math.max(0.3, closest / INNER_RADAR));
  } else if (aheadOuter.length > 0) {
    const closest = aheadOuter[0].distance;
    ego.speed = Math.min(ego.speed, ego.maxSpeed * Math.max(0.6, closest / OUTER_RADAR));
  }

  // ---- STEP 8: Brain "halt" — slow down, pull to nearest edge, brief yield ----
  if (mode === "scp" && ego.brain_action === "halt") {
    const isEdgeLane = currentLane === 0 || currentLane === LANE_COUNT - 1;
    if (!isEdgeLane) {
      // Pull to nearest edge — use lane scoring to pick the clearer side
      const pullLane = laneScores[0] <= laneScores[LANE_COUNT - 1] ? 0 : LANE_COUNT - 1;
      const pullX = road.getLaneCenter(pullLane);
      ego.x += (pullX - ego.x) * 0.04;
      ego.speed = Math.max(ego.speed * 0.9, 1.0); // slow but keep moving
    } else {
      ego.speed = Math.max(ego.speed * 0.88, 0.8); // at edge, cruise slowly
    }
  }
}

// ---------- Sensor-based classification + escalation ----------
// The muscle does NOT know entity types. It only sees raw sensor features:
//   - position, velocity, size
//   - is_stationary (speed ≈ 0)
//   - is_erratic (changing lanes)
//   - has_siren (audio sensor — only ambulances have this)
// Based on BEHAVIOR, the muscle decides:
//   - "Normal traffic" (moving, similar direction, predictable) → avoid locally
//   - "Abnormal" (stationary, has siren, erratic, unknown) → escalate to brain

function getSensorFeatures(t) {
  // SENSOR ONLY — derives features from OBSERVABLE properties.
  // The sensor does NOT know t.kind. It measures physics + audio.
  //
  // How each feature is detected:
  //   is_stationary → speed sensor reads near-zero velocity
  //   is_fast       → speed sensor reads high velocity
  //   is_erratic    → position tracking sees lateral movement between frames
  //   has_siren     → audio sensor detects siren frequency pattern
  //   size          → lidar/radar cross-section measurement
  //
  // Internally these map to game state, but the MUSCLE never sees the kind.

  // Audio sensor: detect siren from audio signature (game: entity has _siren flag)
  const has_siren = !!t._hasSiren;

  // Motion tracking: is the entity changing lanes? (game: _targetX exists = lateral movement)
  const is_erratic = t._targetX !== undefined && Math.abs((t._targetX || t.x) - t.x) > 5;

  return {
    is_stationary: t.speed < 0.2,
    is_fast: t.speed > 3.5,
    is_erratic,
    has_siren,
    speed: t.speed,
    relative_speed: Math.abs(ego.speed - t.speed),
    size: t.height > 45 ? "large" : "normal",
  };
}

function isNormalTraffic(features) {
  // Muscle considers something "normal traffic" if:
  // - It's moving (not stationary)
  // - No siren
  // - Not erratic
  // - Speed is moderate (not racing)
  return !features.is_stationary && !features.has_siren &&
         !features.is_erratic && !features.is_fast;
}

function classifyAndEscalate() {
  const mode = currentMode();
  if (mode !== "scp") return;

  for (const t of traffic) {
    if (t.passed || t.reported || t.damaged) continue;
    const dy = ego.y - t.y;
    if (dy < -100 || dy > 600) continue;

    const features = getSensorFeatures(t);

    // If sensor says "normal traffic" → muscle handles, no escalation
    if (isNormalTraffic(features)) continue;

    // ABNORMAL — something the muscle can't handle on its own.
    // Check pattern store first (learned from previous brain responses)
    const cached = patternStore.lookup(t);
    if (cached === "halt") {
      t.brain_action = "halt";
      t.reported = true;
      t._brainResponded = true;
      ambulancesYielded++;
      score += SCORE.ambulance_yield;
      // Brief halt — yield then resume. Don't re-trigger if already halting.
      if (ego.brain_action !== "halt") {
        ego.brain_action = "halt";
        setTimeout(() => { ego.brain_action = null; }, 2000);
      }
      logToFile("CACHE_HIT_HALT", { entity_id: t.entity_id }, true);
      logTo("log-car", `💾 CACHE → yield ${t.entity_id} ($0)`, "cache");
      continue;
    }
    if (cached === "mark_engage") {
      t.brain_action = "mark_engage";
      t.reported = true;
      obstaclesAvoided++;
      score += SCORE.obstacle_avoided;
      logToFile("CACHE_HIT_AVOID", { entity_id: t.entity_id }, true);
      logTo("log-car", `💾 CACHE → avoid ${t.entity_id} ($0)`, "cache");
      continue;
    }

    // MUSCLE-FIRST: take safe default action NOW, ask brain async
    t.reported = true;
    t.brain_action = "mark_engage"; // default: avoid (safe reflex)
    const eDist = Math.hypot(t.x - ego.x, t.y - ego.y);
    const eAngle = Math.abs(Math.atan2(t.x - ego.x, -(t.y - ego.y)));
    const eSensor = (eDist <= CAMERA_RANGE && eAngle < CAMERA_FOV / 2) ? "CAM" :
                    (eDist <= LIDAR_RANGE) ? "LDR" : "RDR";
    logTo("log-car", `💪 avoid ${t.entity_id} @${Math.round(eDist)}px [${eSensor}]`, "muscle");

    // Ask brain async — fire and forget, brain may override
    emit({
      type: "reallocation_requested",
      actuator_id: "car_0",
      entity_id: t.entity_id,
      cause: "unclassified_sensor_contact",
      delta_state: {
        position: [Math.round(t.x), Math.round(t.y)],
        velocity: [Number(t.vx?.toFixed(1) || 0), Number(t.speed.toFixed(1))],
        is_stationary: features.is_stationary,
        is_fast: features.is_fast,
        is_erratic: features.is_erratic,
        has_siren: features.has_siren,
        size: features.size,
        lane: Math.round((t.x - road.left) / (road.width / LANE_COUNT)),
      },
    });
    logToFile("ESCALATE", { entity_id: t.entity_id, sensor: eSensor, features }, true);
    log(`📡→🧠 consulting brain (async)`, "as");
  }
}

// Track entities we've passed (for scoring ambulances we ignored)
function checkPassed() {
  for (const t of traffic) {
    if (t.passed) continue;
    if (t.y > ego.y + 200) {
      t.passed = true;
      if (t.kind === "ambulance" && t.brain_action !== "halt") {
        ambulancesIgnored++;
        score += SCORE.ambulance_ignored;
        log(`💥 IGNORED ambulance ${t.entity_id}`, "er");
      }
    }
  }
  // Clean old traffic (both behind AND far ahead that we'll never reach)
  for (let i = traffic.length - 1; i >= 0; i--) {
    const dy = ego.y - traffic[i].y;
    if (traffic[i].y > ego.y + 600 || dy > 2000) traffic.splice(i, 1);
  }
}

// ---------- Apply brain assignments ----------
function handleServerMessage(pkt) {
  if (pkt.type === "bulk_assignment") {
    brainCalls++;
    const assigns = pkt.assignments || [];
    for (const intent of assigns) {
      if (intent.type === "halt") {
        ego.brain_action = "halt";
        const t = traffic.find(e => e.entity_id === intent.target_entity_id);
        if (t) {
          t.brain_action = "halt";
          t._brainResponded = true;
          patternStore.learn(t, "halt");
          ambulancesYielded++;
          score += SCORE.ambulance_yield;
        }
        log(`🧠 halt ${intent.target_entity_id} [~$0.001]`, "brain");
      } else if (intent.type === "mark_engage") {
        const t = traffic.find(e => e.entity_id === intent.target_entity_id);
        if (t) {
          t.brain_action = "mark_engage";
          t._brainResponded = true;
          patternStore.learn(t, "mark_engage");
          obstaclesAvoided++;
          score += SCORE.obstacle_avoided;
        }
        log(`🧠 avoid ${intent.target_entity_id} [~$0.001]`, "brain");
      } else if (intent.type === "mark_ignore") {
        const t = traffic.find(e => e.entity_id === intent.target_entity_id);
        if (t) { t.brain_action = "mark_ignore"; t._brainResponded = true; }
        log(`🧠 ignore ${intent.target_entity_id} [~$0.001]`, "brain");
      }
    }
    log(`ASSIGN ${assigns.length} from brain`, "as");

    // Clear halt after a delay (car resumes after yielding)
    if (ego.brain_action === "halt") {
      setTimeout(() => { ego.brain_action = null; }, 2000);
    }
  }
}

// ---------- World state for brain ----------
function snapshotWorld() {
  return {
    scp_version: SCP_VERSION,
    timestamp: performance.now(),
    embodiment_id: embodiment?.embodiment_id || "self-driving-car-v1",
    muscle_mode: currentMode(),
    actuators: [{
      actuator_id: "car_0",
      position: [Math.round(ego.x), Math.round(ego.y)],
      velocity: [Number(ego.speed.toFixed(1)), Number(ego.angle.toFixed(2))],
      status: ego.damaged ? "damaged" : (ego.brain_action === "halt" ? "halted" : "driving"),
    }],
    // Brain gets RAW SENSOR FEATURES — no "kind" label. Brain must classify.
    // Only send entities the muscle escalated (abnormal sensor contacts)
    entities: traffic
      .filter(t => !t.passed && !t.damaged && t.reported && !t._brainResponded)
      .map(t => {
        const f = getSensorFeatures(t);
        return {
          entity_id: t.entity_id,
          position: [Math.round(t.x), Math.round(t.y)],
          velocity: [Number((t.vx || 0).toFixed(1)), Number(t.speed.toFixed(1))],
          // Sensor features only — NO kind label
          is_stationary: f.is_stationary,
          is_fast: f.is_fast,
          is_erratic: f.is_erratic,
          has_siren: f.has_siren,
          size: f.size,
          claimed_by: t.brain_action ? "car_0" : null,
        };
      }),
  };
}

// ---------- Step ----------
function step() {
  if (paused || !ego) return;
  frameCount++;

  spawnTraffic();
  muscleControl();

  // Update traffic + rash driver lane changes
  for (const t of traffic) {
    // Rash drivers randomly change lanes (Indian style)
    if (t.kind === "rash_driver" && !t.passed && !t.damaged) {
      t._rashTimer = (t._rashTimer || 0) + 1;
      if (t._rashTimer >= (t._rashInterval || 90)) {
        t._rashTimer = 0;
        t._rashInterval = 60 + Math.floor(Math.random() * 120);
        // Pick a random adjacent lane and slide toward it
        const currentLaneT = Math.round((t.x - road.left) / (road.width / LANE_COUNT));
        let newLane = currentLaneT + (Math.random() < 0.5 ? -1 : 1);
        newLane = Math.max(0, Math.min(LANE_COUNT - 1, newLane));
        const newX = road.getLaneCenter(newLane);
        t._targetX = newX;
      }
      // Smooth slide toward target lane
      if (t._targetX !== undefined) {
        const tdx = t._targetX - t.x;
        if (Math.abs(tdx) > 2) {
          t.x += tdx * 0.06; // fast lane change — rash!
        } else {
          t.x = t._targetX;
          t._targetX = undefined;
        }
      }
    }
    t.update(road.borders, []);
  }
  // ==== COLLISION AVOIDANCE REFLEX — stop is better than collision ====
  for (const t of traffic) {
    if (t.passed || t.damaged) continue;
    const dxT = t.x - ego.x, dyT = ego.y - t.y;
    const dist = Math.hypot(dxT, dyT);
    if (dist > 80) continue;
    const inOurLane = Math.abs(dxT) < road.laneWidth * 0.7;
    if (inOurLane && dyT > 0 && dist < 50) {
      // EMERGENCY STOP — something directly ahead, too close
      ego.speed = 0;
      // Try escape lane
      const cl = getCurrentLane();
      const left = cl > 0 && !traffic.some(e => !e.passed && !e.damaged && Math.abs(e.x - road.getLaneCenter(cl-1)) < road.laneWidth*0.6 && Math.abs(ego.y-e.y)<60);
      const right = cl < LANE_COUNT-1 && !traffic.some(e => !e.passed && !e.damaged && Math.abs(e.x - road.getLaneCenter(cl+1)) < road.laneWidth*0.6 && Math.abs(ego.y-e.y)<60);
      if (left) ego.x += (road.getLaneCenter(cl-1) - ego.x) * 0.1;
      else if (right) ego.x += (road.getLaneCenter(cl+1) - ego.x) * 0.1;
      if (frameCount % 30 === 0) log(`🚨 REFLEX STOP — ${t.entity_id} @${Math.round(dist)}px ${left?"dodge←":right?"dodge→":"HOLD"}`, "er");
    }
  }

  ego.update(road.borders, traffic);

  if (ego.damaged && !ego._collisionLogged) {
    ego._collisionLogged = true;
    collisions++;
    score += SCORE.collision;
    emit({ type: "intent_failed", actuator_id: "car_0", cause: "collision", delta_state: { position: [Math.round(ego.x), Math.round(ego.y)] } });
    log(`💥 COLLISION`, "er");
  }

  distanceDriven += ego.speed * 0.01;
  score += ego.speed * SCORE.distance;

  classifyAndEscalate();
  checkPassed();
}

// ---------- Render ----------
function render() {
  canvas.height = window.innerHeight;
  ctx.save();
  ctx.translate(0, -ego.y + canvas.height * 0.7);

  // Road
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(road.left - 10, ego.y - canvas.height, road.width + 20, canvas.height * 2.5);
  road.draw(ctx);

  // Traffic
  for (const t of traffic) {
    if (t.passed) continue;
    const cfg = ENTITY_KINDS[t.kind] || { color: "#666" };
    t.draw(ctx, cfg.color);
  }

  // ---- SENSOR VISUALIZATION (3 real sensor layers) ----
  ctx.save();

  // 1. RADAR (12m, front+rear cones) — green front, orange rear
  ctx.beginPath();
  ctx.arc(ego.x, ego.y, RADAR_RANGE, Math.PI, 2 * Math.PI);
  ctx.fillStyle = "rgba(166,227,161,0.04)";
  ctx.fill();
  ctx.strokeStyle = "rgba(166,227,161,0.2)";
  ctx.setLineDash([8, 10]);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(ego.x, ego.y, RADAR_RANGE, 0, Math.PI);
  ctx.fillStyle = "rgba(250,179,135,0.04)";
  ctx.fill();
  ctx.strokeStyle = "rgba(250,179,135,0.2)";
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. LiDAR (8m, 360° full circle) — blue
  ctx.beginPath();
  ctx.arc(ego.x, ego.y, LIDAR_RANGE, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(116,199,236,0.04)";
  ctx.fill();
  ctx.strokeStyle = "rgba(116,199,236,0.3)";
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // 3. CAMERA (7m, forward cone ~120°) — yellow wedge
  ctx.beginPath();
  ctx.moveTo(ego.x, ego.y);
  const camStart = -Math.PI / 2 - CAMERA_FOV / 2;
  const camEnd = -Math.PI / 2 + CAMERA_FOV / 2;
  ctx.arc(ego.x, ego.y, CAMERA_RANGE, camStart, camEnd);
  ctx.closePath();
  ctx.fillStyle = "rgba(249,226,175,0.06)";
  ctx.fill();
  ctx.strokeStyle = "rgba(249,226,175,0.3)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Sensor labels
  ctx.font = "8px ui-monospace";
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(166,227,161,0.5)";
  ctx.fillText("RADAR 12m", ego.x + RADAR_RANGE + 4, ego.y - 4);
  ctx.fillStyle = "rgba(116,199,236,0.5)";
  ctx.fillText("LiDAR 8m", ego.x + LIDAR_RANGE + 4, ego.y + 8);
  ctx.fillStyle = "rgba(249,226,175,0.5)";
  ctx.fillText("CAM 7m", ego.x + CAMERA_RANGE * 0.5, ego.y - CAMERA_RANGE + 10);
  ctx.fillStyle = "rgba(250,179,135,0.5)";
  ctx.fillText("REAR", ego.x + 8, ego.y + RADAR_RANGE - 8);

  // ---- SENSOR BLIPS: show what each sensor detects ----
  for (const t of traffic) {
    if (t.passed || t.damaged) continue;
    const bdx = t.x - ego.x;
    const bdy = t.y - ego.y;
    const dist = Math.hypot(bdx, bdy);
    if (dist > RADAR_RANGE) continue;

    // Determine which sensors can see this entity
    const inLidar = dist <= LIDAR_RANGE;
    const inRadar = dist <= RADAR_RANGE;
    const angleToEntity = Math.atan2(bdx, -bdy); // angle from car's forward
    const inCameraFOV = Math.abs(angleToEntity) < CAMERA_FOV / 2;
    const inCamera = dist <= CAMERA_RANGE && inCameraFOV;

    const sf = getSensorFeatures(t);

    // Blip ring color shows which sensor is primary
    let blipColor, sensorTag;
    if (inCamera && sf.has_siren) {
      blipColor = "rgba(243,139,168,0.9)"; sensorTag = "CAM:🚨";
    } else if (inCamera && sf.is_stationary) {
      blipColor = "rgba(249,226,175,0.9)"; sensorTag = "CAM:⚠";
    } else if (inLidar) {
      blipColor = "rgba(116,199,236,0.7)"; sensorTag = "LDR";
    } else if (inRadar) {
      blipColor = "rgba(166,227,161,0.35)"; sensorTag = "RDR";
    } else {
      continue;
    }

    // Pulsing blip
    const pulse = 3 + Math.sin(performance.now() / 200 + dist) * 2;
    ctx.beginPath();
    ctx.arc(t.x, t.y, pulse, 0, Math.PI * 2);
    ctx.fillStyle = blipColor;
    ctx.fill();

    // Sensor ring (which sensor sees it)
    if (inCamera) {
      ctx.strokeStyle = "rgba(249,226,175,0.4)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(t.x, t.y, pulse + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (inLidar && !inCamera) {
      ctx.strokeStyle = "rgba(116,199,236,0.3)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(t.x, t.y, pulse + 3, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Line from car to blip
    ctx.beginPath();
    ctx.moveTo(ego.x, ego.y);
    ctx.lineTo(t.x, t.y);
    ctx.strokeStyle = blipColor.replace(/[\d.]+\)$/, "0.12)");
    ctx.lineWidth = 1;
    ctx.stroke();

    // Label: sensor + distance
    ctx.fillStyle = "rgba(205,214,244,0.7)";
    ctx.font = "7px ui-monospace";
    ctx.textAlign = "center";
    ctx.fillText(`${sensorTag} ${Math.round(dist)}`, t.x, t.y - pulse - 4);
  }
  ctx.restore();

  // Ego car (drawn on top of radar)
  ego.draw(ctx, "#89b4fa");

  ctx.restore();

  // HUD
  if (sessionStartTs > 0) {
    elapsedMs = paused ? elapsedMs : (performance.now() - sessionStartTs);
    const totalSec = Math.floor(elapsedMs / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    const timerStr = `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    const cStats = patternStore.stats();

    ctx.fillStyle = "rgba(11,14,20,0.7)";
    ctx.fillRect(0, 0, CANVAS_W, 28);
    ctx.font = "bold 13px ui-monospace";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f9e2af";
    ctx.textAlign = "center";
    ctx.fillText(timerStr, CANVAS_W / 2, 15);
    ctx.fillStyle = "#cba6f7";
    ctx.textAlign = "left";
    ctx.fillText(`M:${brainCalls}`, 4, 15);
    ctx.fillStyle = "#a6e3a1";
    ctx.textAlign = "right";
    ctx.fillText(`C:${cStats.hits}`, CANVAS_W - 4, 15);
  }
}

// ---------- Metrics ----------
let lastFpsTs = performance.now();
let fpsFrames = 0;
let displayFps = 60;

function updateMetrics() {
  const now = performance.now();
  fpsFrames++;
  if (now - lastFpsTs >= 500) {
    displayFps = Math.round((fpsFrames * 1000) / (now - lastFpsTs));
    fpsFrames = 0;
    lastFpsTs = now;
  }
  document.getElementById("m-score").textContent = Math.round(score);
  document.getElementById("m-dist").textContent = Math.round(distanceDriven);
  document.getElementById("m-collisions").textContent = collisions;
  document.getElementById("m-yields").textContent = ambulancesYielded;
  document.getElementById("m-avoided").textContent = obstaclesAvoided;
  document.getElementById("m-amb-ignored").textContent = ambulancesIgnored;
  document.getElementById("m-bcm").textContent = brainCalls;
  document.getElementById("m-fps").textContent = displayFps;
  document.getElementById("m-speed").textContent = ego ? ego.speed.toFixed(1) : "0";
  const cs = patternStore.stats();
  document.getElementById("m-cache").textContent = `${cs.hits}h/${cs.misses}m`;
  if (frameCount % 300 === 0) patternStore.save();
}

// ---------- WebSocket ----------
function connectWs() {
  try { ws = new WebSocket(WS_URL); }
  catch { setTimeout(connectWs, 1500); return; }
  ws.onopen = () => {
    wsConnected = true;
    document.getElementById("ws").className = "ws up";
    document.getElementById("ws").textContent = "WS: connected";
    log("WS connected", "ev");
    fetch("./embodiment.json").then(r => r.json()).then(emb => {
      embodiment = emb;
      ws.send(JSON.stringify({ type: "register_embodiment", scp_version: SCP_VERSION, embodiment }));
      log(`Registered ${emb.label}`, "ev");
    });
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

let lastWorldPush = 0;
function pushWorldState(now) {
  if (!wsConnected || !ego) return;
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
  ws.send(JSON.stringify({ type: "log_line", mode: currentMode(), scp_only, tag, payload, ts: Date.now() }));
}

// Two log panels: engine (spawns, escalations, brain) and car (driving, lanes, speed)
function logTo(panelId, msg, cls = "") {
  const el = document.getElementById(panelId);
  if (!el) return;
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = `[${(performance.now() / 1000).toFixed(1)}s] ${msg}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
  while (el.children.length > 200) el.removeChild(el.firstChild);
}
const log = (msg, cls = "") => {
  // Route: muscle/brain/cache → car panel, sensors/spawns/system → engine panel
  const isCar = cls === "muscle" || cls === "brain" || cls === "cache" || cls === "safety" ||
    msg.includes("💪") || msg.includes("🧠") || msg.includes("💾") || msg.includes("🛣");
  const isEngine = !isCar && (msg.includes("📡") || msg.includes("SPAWN") || msg.includes("CONTACT") ||
    msg.includes("PAUSED") || msg.includes("RESUMED") || msg.includes("RESET") ||
    msg.includes("MODE") || msg.includes("WS") || msg.includes("Registered") || msg.includes("Loaded"));
  if (isCar) logTo("log-car", msg, cls);
  else if (isEngine) logTo("log-engine", msg, cls);
  else logTo("log-engine", msg, cls); // default to engine
};

// ---------- Main loop ----------
function animate() {
  step();
  if (ego) {
    if (!paused) pushWorldState(performance.now());
    render();
  }
  updateMetrics();
  requestAnimationFrame(animate);
}

// ---------- Controls ----------
function setPaused(p) {
  paused = p;
  document.getElementById("playpause").textContent = paused ? "▶ Play" : "⏸ Pause";
  if (!paused && sessionStartTs === 0) sessionStartTs = performance.now();
  log(paused ? "⏸ PAUSED" : "▶ RESUMED", "as");
}

document.getElementById("playpause").addEventListener("click", () => setPaused(!paused));
document.addEventListener("keydown", (e) => { if (e.code === "Space") { e.preventDefault(); setPaused(!paused); } });

document.getElementById("reset").addEventListener("click", () => {
  traffic.length = 0;
  score = 0; distanceDriven = 0; collisions = 0;
  ambulancesYielded = 0; ambulancesIgnored = 0; obstaclesAvoided = 0;
  brainCalls = 0; frameCount = 0; spawnCounter = 0;
  sessionStartTs = 0; elapsedMs = 0;
  initEgo();
  log("RESET", "ev");
});

document.getElementById("mode").addEventListener("change", (e) => log(`MODE = ${e.target.value}`, "as"));

// ---------- Boot ----------
initEgo();
patternStore.load();
connectWs();
setPaused(true);
requestAnimationFrame(animate);
