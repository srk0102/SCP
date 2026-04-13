"""
SCP MuJoCo Ant Adapter -- muscle layer
Real physics. Real joint constraints. Real contact simulation.
Same SCP protocol. Brain calls drop over time.

Run:
  Terminal 1: node bridge.js
  Terminal 2: python muscle.py
"""

import mujoco
import numpy as np
import requests
import json
import time
import os

# -- Config --
BRIDGE_URL = os.environ.get("SCP_BRIDGE_URL", "http://localhost:3000")
TICK_HZ = 50  # physics ticks per second
LOOPS = 10  # number of reporting intervals
TICKS_PER_LOOP = 100  # ticks per reporting interval (2 seconds each)
MODEL_PATH = os.path.join(os.path.dirname(__file__), "ant.xml")
PATTERN_FILE = os.path.join(os.path.dirname(__file__), "patterns.json")

# -- Pattern Store (Python port of scp-core PatternStore) --

class PatternStore:
    def __init__(self, confidence_threshold=0.15, exploration_rate=0.1, max_patterns=500):
        self.patterns = {}
        self.confidence_threshold = confidence_threshold
        self.exploration_rate = exploration_rate
        self.max_patterns = max_patterns
        self.hits = 0
        self.misses = 0
        self.explorations = 0
        self.corrections = 0

    def features(self, state):
        """Extract matchable features from ant state."""
        return {
            "height_bucket": round(state["height"] * 5) / 5,  # 0.2 increments
            "is_upright": state["height"] > 0.3,
            "is_moving": abs(state["forward_vel"]) > 0.1,
            "speed_bucket": "fast" if abs(state["forward_vel"]) > 1.0 else "slow" if abs(state["forward_vel"]) < 0.3 else "medium",
            "has_contact": state["contact_count"] > 0,
            "is_tilted": abs(state["pitch"]) > 0.5 or abs(state["roll"]) > 0.5,
        }

    def _hash(self, feat):
        keys = sorted(feat.keys())
        return "|".join(f"{k}:{feat[k]}" for k in keys)

    def _confidence(self, pattern):
        return pattern["count"] / 20.0

    def lookup(self, state):
        feat = self.features(state)
        h = self._hash(feat)
        p = self.patterns.get(h)
        if p and self._confidence(p) >= self.confidence_threshold:
            # Exploration: randomly skip to verify with brain
            if self.exploration_rate > 0 and np.random.random() < self.exploration_rate:
                self.explorations += 1
                return None
            self.hits += 1
            return p["decision"]
        self.misses += 1
        return None

    def learn(self, state, decision):
        feat = self.features(state)
        h = self._hash(feat)
        existing = self.patterns.get(h)
        if not existing:
            self.patterns[h] = {"decision": decision, "count": 1}
            if len(self.patterns) > self.max_patterns:
                worst = min(self.patterns, key=lambda k: self.patterns[k]["count"])
                del self.patterns[worst]
            return
        if existing["decision"] == decision:
            existing["count"] = min(existing["count"] + 1, 20)
        else:
            existing["count"] = 1
            existing["decision"] = decision

    def correct(self, state, brain_decision):
        feat = self.features(state)
        h = self._hash(feat)
        p = self.patterns.get(h)
        if p and p["decision"] != brain_decision:
            p["count"] = 1
            p["decision"] = brain_decision
            self.corrections += 1

    def save(self):
        with open(PATTERN_FILE, "w") as f:
            json.dump(self.patterns, f)

    def load(self):
        if os.path.exists(PATTERN_FILE):
            with open(PATTERN_FILE) as f:
                self.patterns = json.load(f)
            print(f"[pattern-store] loaded {len(self.patterns)} patterns")

    def stats(self):
        total = len(self.patterns)
        confident = sum(1 for p in self.patterns.values() if self._confidence(p) >= self.confidence_threshold)
        return {
            "total": total,
            "confident": confident,
            "hits": self.hits,
            "misses": self.misses,
            "explorations": self.explorations,
            "corrections": self.corrections,
        }


# -- Reflex layer --

def reflex_check(state):
    """Hardcoded rules. Never asks brain. Fires instantly."""
    # Falling: height too low, emergency stabilize
    if state["height"] < 0.2:
        return "stabilize"
    # Flipped: upside down, emergency reset
    if state["height"] < 0.15:
        return "reset"
    return None


# -- Action executors --

def apply_action(data, action):
    """Convert a brain/cache decision into joint torques."""
    if action == "walk_forward":
        # Alternating gait: diagonal legs push together
        phase = (data.time * 3) % (2 * np.pi)
        s = np.sin(phase)
        c = np.cos(phase)
        data.ctrl[:] = [s, c, -s, -c, -s, -c, s, c]  # diagonal gait
    elif action == "turn_left":
        data.ctrl[:] = [0.5, 0.3, -0.8, -0.3, 0.5, 0.3, -0.8, -0.3]
    elif action == "turn_right":
        data.ctrl[:] = [-0.8, -0.3, 0.5, 0.3, -0.8, -0.3, 0.5, 0.3]
    elif action == "stabilize":
        # Pull all legs inward and down
        data.ctrl[:] = [0, 0.5, 0, 0.5, 0, 0.5, 0, 0.5]
    elif action == "speed_up":
        phase = (data.time * 5) % (2 * np.pi)
        s = np.sin(phase)
        c = np.cos(phase)
        data.ctrl[:] = [s * 0.8, c * 0.8, -s * 0.8, -c * 0.8, -s * 0.8, -c * 0.8, s * 0.8, c * 0.8]
    elif action == "reset":
        data.ctrl[:] = 0
    else:
        # Default: gentle walk
        phase = (data.time * 2) % (2 * np.pi)
        s = np.sin(phase)
        data.ctrl[:] = [s * 0.3, 0.3, -s * 0.3, 0.3, -s * 0.3, 0.3, s * 0.3, 0.3]


def read_state(model, data):
    """Read sensor data from MuJoCo into an SCP state dict."""
    # Torso position and orientation
    torso_pos = data.qpos[:3].copy()
    torso_quat = data.qpos[3:7].copy()

    # Convert quaternion to euler-ish (roll, pitch)
    # Simple approximation: use quat components
    roll = 2 * (torso_quat[0] * torso_quat[1] + torso_quat[2] * torso_quat[3])
    pitch = 2 * (torso_quat[0] * torso_quat[2] - torso_quat[1] * torso_quat[3])

    # Velocity
    forward_vel = data.qvel[0]  # x velocity
    lateral_vel = data.qvel[1]  # y velocity

    # Contact count
    contact_count = data.ncon

    return {
        "height": float(torso_pos[2]),
        "x": float(torso_pos[0]),
        "y": float(torso_pos[1]),
        "forward_vel": float(forward_vel),
        "lateral_vel": float(lateral_vel),
        "roll": float(roll),
        "pitch": float(pitch),
        "contact_count": int(contact_count),
        "time": float(data.time),
    }


# -- Bridge communication --

def emit_event(state, event_type):
    """Send semantic event to SCP bridge via HTTP."""
    try:
        requests.post(f"{BRIDGE_URL}/emit", json={
            "type": event_type,
            "state": state,
            "timestamp": time.time(),
        }, timeout=0.5)
    except requests.exceptions.ConnectionError:
        pass  # bridge not running, continue autonomously

def poll_brain():
    """Poll for brain decisions from SCP bridge."""
    try:
        resp = requests.get(f"{BRIDGE_URL}/poll", timeout=0.5)
        data = resp.json()
        messages = data.get("messages", [])
        if messages:
            return messages[-1]  # latest decision
    except (requests.exceptions.ConnectionError, json.JSONDecodeError):
        pass
    return None


# -- Classify situation for brain --

def classify_situation(state):
    """Determine what kind of situation the ant is in."""
    if state["height"] < 0.3:
        return "falling"
    if abs(state["forward_vel"]) < 0.1 and state["contact_count"] > 2:
        return "stuck"
    if abs(state["pitch"]) > 0.5 or abs(state["roll"]) > 0.5:
        return "tilted"
    if abs(state["forward_vel"]) > 1.0:
        return "moving_fast"
    return "moving_normal"


# -- Main loop --

def main():
    print("[SCP MuJoCo Ant] Loading model...")
    model = mujoco.MjModel.from_xml_path(MODEL_PATH)
    data = mujoco.MjData(model)

    store = PatternStore(exploration_rate=0.02)  # 2% verification, not 10%
    store.load()

    print(f"[SCP MuJoCo Ant] Starting {LOOPS} loops x {TICKS_PER_LOOP} ticks at {TICK_HZ}Hz")
    print(f"[SCP MuJoCo Ant] Bridge: {BRIDGE_URL}")
    print()

    total_brain_calls = 0
    total_cache_hits = 0
    total_reflex_fires = 0

    for loop in range(LOOPS):
        brain_calls = 0
        cache_hits = 0
        reflex_fires = 0

        for tick in range(TICKS_PER_LOOP):
            # Step physics
            mujoco.mj_step(model, data)

            # Read sensors
            state = read_state(model, data)

            # Step 1: Reflex check (instant, no brain)
            reflex_action = reflex_check(state)
            if reflex_action:
                apply_action(data, reflex_action)
                reflex_fires += 1
                continue

            # Step 2: Pattern store lookup
            cached = store.lookup(state)
            if cached:
                apply_action(data, cached)
                cache_hits += 1
                continue

            # Step 3: Classify and ask brain
            situation = classify_situation(state)
            emit_event(state, f"situation_{situation}")

            # Step 4: Poll for brain response
            brain_resp = poll_brain()
            if brain_resp and brain_resp.get("decision"):
                decision = brain_resp["decision"]
            else:
                # No brain available -- use default mapping
                default_actions = {
                    "falling": "stabilize",
                    "stuck": "turn_left",
                    "tilted": "stabilize",
                    "moving_fast": "walk_forward",
                    "moving_normal": "walk_forward",
                }
                decision = default_actions.get(situation, "walk_forward")

            brain_calls += 1

            # Step 5: Learn and apply
            store.learn(state, decision)
            apply_action(data, decision)

            # Brief sleep to not hammer the HTTP endpoint
            time.sleep(1.0 / TICK_HZ)

        total_brain_calls += brain_calls
        total_cache_hits += cache_hits
        total_reflex_fires += reflex_fires

        print(f"  Loop {loop + 1:2d}: brain={brain_calls:3d}  cache={cache_hits:3d}  reflex={reflex_fires:3d}  "
              f"height={read_state(model, data)['height']:.2f}  "
              f"x={read_state(model, data)['x']:.2f}")

    # Save patterns for next session
    store.save()

    # Final report
    stats = store.stats()
    print()
    print("=== Session Results ===")
    print(f"  Total brain calls:  {total_brain_calls}")
    print(f"  Total cache hits:   {total_cache_hits}")
    print(f"  Total reflex fires: {total_reflex_fires}")
    print(f"  Patterns stored:    {stats['total']}")
    print(f"  Confident:          {stats['confident']}")
    print(f"  Explorations:       {stats['explorations']}")
    print(f"  Corrections:        {stats['corrections']}")

    if total_brain_calls == 0:
        print("\n  Brain calls dropped to zero. Muscle learned.")
    elif total_cache_hits > total_brain_calls:
        print(f"\n  Cache handling {total_cache_hits}/{total_cache_hits + total_brain_calls} "
              f"({100 * total_cache_hits / (total_cache_hits + total_brain_calls):.0f}%) of decisions.")


if __name__ == "__main__":
    main()
