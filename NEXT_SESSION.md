# Next Session: Advanced Highway Simulator (Adapter #2 v2)

## Context

SCP protocol is PROVEN. Two adapters working:
1. Missile defense — 125+ assign_targets, pattern store, 3-mode comparison
2. Self-driving car — 749 score, 0 collisions, sensor-based classification

The protocol, MCP server, bridge, schema — ALL FROZEN. Do not touch them.
This session builds a realistic highway simulator as a NEW adapter that proves
SCP handles real-world chaos, not just clean simulations.

## What to build

### Road: 10-lane divided highway

```
|  Lane 4  |  Lane 3  |  Lane 2  |  Lane 1  |  Lane 0  | DIVIDER |  Lane 0' |  Lane 1' |  Lane 2' |  Lane 3' |  Lane 4' |
|  ← ← ←  |  ← ← ←  |  ← ← ←  |  ← ← ←  |  ← ← ←  | ██████  |  → → →  |  → → →  |  → → →  |  → → →  |  → → →  |
                        OUR SIDE (5 lanes)                                      OPPOSITE SIDE (5 lanes)
```

- Canvas width: 600px (wider to fit 10 lanes + divider)
- Our car drives in OUR SIDE lanes (0-4)
- Opposite traffic drives in the other direction (visual only — different y velocity)
- Median divider is a physical barrier (no crossing)
- Lane width: ~50px each

### Traffic signals

```javascript
const SIGNAL_INTERVAL = 600; // frames (~10 sec cycle)
const signals = [
  { y: -2000, state: "green", timer: 0 },  // spawn ahead periodically
  { y: -5000, state: "red", timer: 300 },
];
```

- Signals appear on the road at fixed y intervals
- Cycle: green (6s) → yellow (2s) → red (6s)
- Muscle behavior:
  - Green: drive through (whitelist)
  - Yellow: slow down if close, stop if far (muscle decision)
  - Red: STOP (whitelist — no brain needed)
  - Red BUT ambulance behind with siren: ASK BRAIN (should I run the red?)
- Visual: colored circle on the road + vertical pole on the side

### Entity types (expanded)

| Entity | Sensor detection | Muscle handles? | Brain needed? |
|---|---|---|---|
| traffic_car | LiDAR + Radar | Yes — lane change | No |
| rash_driver | LiDAR (erratic movement) | Yes — avoid | No |
| ambulance | Camera (siren lights) | No — can't classify | Yes — halt or yield |
| obstacle | LiDAR (stationary) | Partially — slow down | Yes — classify |
| auto_rickshaw | LiDAR (small, slow, erratic) | Yes — avoid | No |
| motorcycle | LiDAR (tiny, fast, lane-splitting) | Yes — wide berth | No |
| pedestrian | Camera (at crossing zones only) | EMERGENCY STOP (whitelist) | No |
| bus | LiDAR (large, slow, stops frequently) | Yes — overtake | No |
| opposite_ambulance | Camera (siren in opposite lanes) | IGNORE — not our side | No |

### Road features

**Pedestrian crossings:**
- Appear at fixed intervals (every ~8000px of road)
- Painted white stripes on the road (visible)
- Camera detects the crossing zone
- If pedestrian is AT the crossing → emergency brake (whitelist)
- If no pedestrian → drive through

**Road narrowing:**
- Sections where the road goes from 5 lanes to 3 lanes
- Orange cones/barriers on the sides
- Muscle detects narrowing via LiDAR (barriers on sides)
- Car must merge to inner lanes

**Flyover ramps:**
- Visual only (road elevation indicator)
- Speed limit changes on flyover (camera reads sign)

**Road symbols (camera-visible):**
- Speed limit signs: "60" "80" "40" painted or posted
- Lane merge arrows: "←" painted on road
- Stop line at signals: thick white line
- Pedestrian crossing: zebra stripes
- The CAMERA sensor detects these symbols
- Muscle reads speed limit and adjusts maxSpeed
- Muscle reads merge arrows and pre-positions

### Opposite-direction traffic

- Spawns in lanes 0'-4' on the opposite side of the divider
- Drives in the OPPOSITE y direction (toward our car visually)
- Our car's sensors can SEE them (radar/LiDAR detect them)
- But the muscle knows they're on the OTHER SIDE of the divider → ignore
- KEY TEST: ambulance with siren in OPPOSITE lanes → muscle detects siren via audio,
  but checks position → opposite side → DO NOT YIELD
- Without this check (no-brainer mode): car might stop for an opposite-lane ambulance

### Indian chaos mode

Toggle in the UI:
- `chaos: false` → normal highway behavior
- `chaos: true` → Indian mode:
  - Auto-rickshaws drift between lanes randomly
  - Motorcycles lane-split (drive between two cars)
  - Pedestrians cross ANYWHERE (not just crossings)
  - Cars honk (audio events) — purely cosmetic
  - Speed limits ignored by 30% of traffic
  - Wrong-way drivers occasionally (1% of spawns drive opposite in our lanes)

### Sensor layer (kept from current implementation)

| Sensor | Range | FOV | Detects |
|---|---|---|---|
| Camera | 140px (7m) | Forward 120° | Siren, shape, road symbols, pedestrians |
| LiDAR | 160px (8m) | 360° | Position of everything, size |
| Radar | 250px (12m) | Front + rear cones | Speed, distance, closing rate |

### Scoring

| Event | Points |
|---|---|
| Distance driven (per meter) | +0.01 |
| Red light obeyed | +2 |
| Red light run | -10 |
| Ambulance yielded (our side) | +5 |
| Ambulance yielded (opposite side — wrong!) | -3 |
| Pedestrian stopped for | +5 |
| Pedestrian hit | -50 |
| Collision | -10 |
| Speed limit obeyed | +0.5/sec |
| Lane merge completed | +2 |

### Three-mode comparison (same as current)

**No-brainer**: stops for ALL ambulances (including opposite side), ignores road symbols,
drives max speed always, emergency brakes for pedestrians (whitelist only).

**Brainer**: classifies correctly but too slow — runs red lights waiting for brain
response, misses pedestrians because brain takes 2s.

**SCP**: muscle handles traffic/signals/pedestrians locally. Brain classifies ambulances
(which side? yield or ignore?), reads road symbols brain can't classify (construction
detour sign), and handles the 1% wrong-way driver in chaos mode.

## Files to create/modify

### New folder: `adapters/highway/`

```
adapters/highway/
├── embodiment.json     — 10-lane highway body spec
├── muscle.html         — wider canvas (600px), signal indicators, chaos toggle
├── muscle.js           — road class (10 lanes + divider), all entity types,
│                         traffic signals, crossings, narrowing, sensor layers
├── pattern-store.js    — copy from self-driving-car
└── system-prompt.md    — brain classification rules for highway entities
```

### Do NOT change
- `schema/scp-v0.json` — FROZEN
- `server/*` — FROZEN
- `client/qwen-mcp-bridge.js` — only uses PROMPT_PATH env var (already supports per-adapter prompts)

### Bridge invocation
```bash
cd scp-mvp/adapters/highway && python -m http.server 8080
cd scp-mvp/client && PROMPT_PATH=../adapters/highway/system-prompt.md node qwen-mcp-bridge.js
```

## Architecture reminder

```
Nova Micro (Bedrock, $0.001/call)
  ↓ (only when muscle escalates)
MCP Bridge (qwen-mcp-bridge.js) — UNCHANGED
  ↓
MCP Server (mcp-server.js) — UNCHANGED
  ↓ WebSocket :7777
Highway Muscle (muscle.js) — NEW ADAPTER
  • 10-lane road with divider
  • Traffic signals
  • 9+ entity types
  • 3 sensor layers (camera/lidar/radar)
  • Pattern store (muscle memory)
  • Pedestrian crossings
  • Road narrowing
  • Indian chaos toggle
```

Same protocol. Same brain. Same server. Different body. That's SCP.

## Success criteria

1. Car drives 10+ minutes on 10-lane highway with 0 collisions
2. Stops at red lights, goes on green (muscle alone)
3. Yields to ambulance on OUR side, ignores ambulance on OPPOSITE side
4. Emergency brakes for pedestrians at crossings
5. Handles road narrowing (merges lanes)
6. Brain calls < 10/min (muscle handles 90%+ locally)
7. Cache hits climb over session (muscle memory learns)
8. Chaos mode: survives Indian traffic for 5+ minutes
9. Score stays positive across all conditions
10. Same protocol, same server, zero changes to SCP layer

## The pitch after this works

> "Same LLM, same protocol, zero training. Adapter #1 defended a border with
> 10 missile launchers. Adapter #2 drove a car through Indian traffic chaos
> with traffic signals, pedestrians, ambulances, and wrong-way drivers. The
> protocol didn't change. The brain didn't change. Just the adapter."

That is SCP.
