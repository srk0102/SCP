"""
SCP MuJoCo Cart-Pole -- muscle layer
Keep the pole balanced. One actuator. Clear visual goal.
Brain calls drop to zero as the pattern store learns.

Run headless:  python muscle.py
Run with viewer: python muscle.py --view
"""

import mujoco
import mujoco.viewer
import numpy as np
import json
import time
import sys
import os

MODEL_PATH = os.path.join(os.path.dirname(__file__), "cartpole.xml")
PATTERN_FILE = os.path.join(os.path.dirname(__file__), "patterns.json")


# -- Pattern Store --

class PatternStore:
    def __init__(self, exploration_rate=0.02):
        self.patterns = {}
        self.confidence_threshold = 0.15
        self.exploration_rate = exploration_rate
        self.hits = 0
        self.misses = 0
        self.explorations = 0

    def features(self, state):
        return {
            "angle_bucket": round(state["pole_angle"] * 4) / 4,  # 0.25 rad increments
            "tilting": "right" if state["pole_vel"] > 0.3 else "left" if state["pole_vel"] < -0.3 else "steady",
            "off_center": "right" if state["cart_pos"] > 0.5 else "left" if state["cart_pos"] < -0.5 else "center",
        }

    def _hash(self, feat):
        return "|".join(f"{k}:{feat[k]}" for k in sorted(feat))

    def lookup(self, state):
        h = self._hash(self.features(state))
        p = self.patterns.get(h)
        if p and p["count"] / 20.0 >= self.confidence_threshold:
            if self.exploration_rate > 0 and np.random.random() < self.exploration_rate:
                self.explorations += 1
                return None
            self.hits += 1
            return p["decision"]
        self.misses += 1
        return None

    def learn(self, state, decision):
        h = self._hash(self.features(state))
        p = self.patterns.get(h)
        if not p:
            self.patterns[h] = {"decision": decision, "count": 1}
            return
        if p["decision"] == decision:
            p["count"] = min(p["count"] + 1, 20)
        else:
            p["count"] = 1
            p["decision"] = decision

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
        confident = sum(1 for p in self.patterns.values() if p["count"] / 20.0 >= self.confidence_threshold)
        return {"total": total, "confident": confident, "hits": self.hits, "misses": self.misses}


# -- Read state --

def read_state(data):
    return {
        "cart_pos": float(data.qpos[0]),
        "cart_vel": float(data.qvel[0]),
        "pole_angle": float(data.qpos[1]),
        "pole_vel": float(data.qvel[1]),
    }


# -- Brain logic (local, no HTTP needed for demo) --

def brain_decide(state):
    """Simple proportional controller as the 'brain'.
    In production this would be an LLM call via OllamaBridge."""
    angle = state["pole_angle"]
    vel = state["pole_vel"]
    cart = state["cart_pos"]

    # PD controller: gentle push opposite to tilt, strong cart centering
    force = -1.5 * angle - 0.5 * vel - 0.8 * cart - 0.3 * state["cart_vel"]
    return max(-0.5, min(0.5, force))


# -- Reflex --

def reflex_check(state):
    """Emergency: if pole tilting fast past 25 degrees, firm push to recover."""
    if state["pole_angle"] > 0.45 and state["pole_vel"] > 0.5:
        return -0.5
    if state["pole_angle"] < -0.45 and state["pole_vel"] < -0.5:
        return 0.5
    return None


# -- Discretize brain output for pattern store --

def discretize_force(force):
    """Bucket continuous force into 5 levels for caching."""
    if force > 0.6:
        return "strong_right"
    if force > 0.2:
        return "light_right"
    if force < -0.6:
        return "strong_left"
    if force < -0.2:
        return "light_left"
    return "hold"


def force_from_decision(decision):
    """Convert cached decision back to force."""
    return {
        "strong_right": 0.4,
        "light_right": 0.2,
        "hold": 0.0,
        "light_left": -0.2,
        "strong_left": -0.4,
    }.get(decision, 0.0)


# -- Main --

def main():
    use_viewer = "--view" in sys.argv

    print("[SCP Cart-Pole] Loading model...")
    model = mujoco.MjModel.from_xml_path(MODEL_PATH)
    data = mujoco.MjData(model)

    # Give pole a small initial push so it starts falling
    data.qvel[1] = 0.5

    store = PatternStore()
    store.load()

    brain_calls = 0
    cache_hits = 0
    reflex_fires = 0
    tick = 0
    loop_brain = 0
    loop_cache = 0
    loop_reflex = 0
    loop_num = 0

    episodes = 0

    def reset_pole():
        nonlocal episodes
        mujoco.mj_resetData(model, data)
        data.qvel[1] = np.random.uniform(-0.5, 0.5)  # random small push
        data.qpos[0] = np.random.uniform(-0.3, 0.3)   # random cart offset
        episodes += 1

    def step_scp():
        nonlocal brain_calls, cache_hits, reflex_fires, tick
        nonlocal loop_brain, loop_cache, loop_reflex, loop_num
        tick += 1

        state = read_state(data)

        # Auto-reset if pole fell beyond recovery (past 60 degrees)
        if abs(state["pole_angle"]) > 1.0 or abs(state["cart_pos"]) > 1.8:
            reset_pole()
            return

        # Step 1: Reflex (emergency push when pole tilting fast past 30 deg)
        reflex = reflex_check(state)
        if reflex is not None:
            data.ctrl[0] = reflex
            reflex_fires += 1
            loop_reflex += 1
            return

        # Step 2: Pattern store
        cached = store.lookup(state)
        if cached:
            data.ctrl[0] = force_from_decision(cached)
            cache_hits += 1
            loop_cache += 1
            return

        # Step 3: Brain
        force = brain_decide(state)
        decision = discretize_force(force)
        data.ctrl[0] = force
        store.learn(state, decision)
        brain_calls += 1
        loop_brain += 1

    def print_loop():
        nonlocal loop_brain, loop_cache, loop_reflex, loop_num
        loop_num += 1
        total = loop_brain + loop_cache + loop_reflex
        rate = loop_cache / total * 100 if total > 0 else 0
        state = read_state(data)
        print(f"  Loop {loop_num:2d}: brain={loop_brain:3d}  cache={loop_cache:3d}  reflex={loop_reflex:3d}  "
              f"angle={state['pole_angle']:+.2f}  cart={state['cart_pos']:+.2f}  rate={rate:.0f}%")
        loop_brain = 0
        loop_cache = 0
        loop_reflex = 0

    if use_viewer:
        print("[SCP Cart-Pole] Visual mode -- close window to exit\n")
        with mujoco.viewer.launch_passive(model, data) as viewer:
            while viewer.is_running():
                step_scp()
                mujoco.mj_step(model, data)
                viewer.sync()

                if tick % 200 == 0:
                    print_loop()

                time.sleep(1.0 / 60)
    else:
        print(f"[SCP Cart-Pole] Headless mode -- 10 loops x 200 ticks\n")
        for _ in range(10):
            for _ in range(200):
                step_scp()
                mujoco.mj_step(model, data)
            print_loop()

    store.save()

    s = store.stats()
    print(f"\n=== Results ===")
    print(f"  Brain calls:  {brain_calls}")
    print(f"  Cache hits:   {cache_hits}")
    print(f"  Reflex fires: {reflex_fires}")
    print(f"  Patterns:     {s['total']} ({s['confident']} confident)")

    total = brain_calls + cache_hits
    if total > 0:
        print(f"  Cache rate:   {cache_hits / total * 100:.0f}%")

    if brain_calls == 0:
        print("\n  Brain calls dropped to zero. Muscle learned.")


if __name__ == "__main__":
    main()
