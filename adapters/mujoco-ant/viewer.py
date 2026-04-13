"""
SCP MuJoCo Ant -- Visual Mode
Opens the MuJoCo 3D viewer so you can watch the ant walk.
Same SCP muscle logic, with rendering.

Run: python viewer.py
"""

import mujoco
import mujoco.viewer
import numpy as np
import time
import os
from muscle import PatternStore, reflex_check, apply_action, read_state, classify_situation

MODEL_PATH = os.path.join(os.path.dirname(__file__), "ant.xml")

def main():
    model = mujoco.MjModel.from_xml_path(MODEL_PATH)
    data = mujoco.MjData(model)

    store = PatternStore()
    store.load()

    brain_calls = 0
    cache_hits = 0
    tick = 0

    def controller(model, data):
        nonlocal brain_calls, cache_hits, tick
        tick += 1

        state = read_state(model, data)

        # Reflex
        reflex_action = reflex_check(state)
        if reflex_action:
            apply_action(data, reflex_action)
            return

        # Cache
        cached = store.lookup(state)
        if cached:
            apply_action(data, cached)
            cache_hits += 1
            return

        # Brain (default actions, no HTTP in viewer mode)
        situation = classify_situation(state)
        defaults = {
            "falling": "stabilize",
            "stuck": "turn_left",
            "tilted": "stabilize",
            "moving_fast": "walk_forward",
            "moving_normal": "walk_forward",
        }
        decision = defaults.get(situation, "walk_forward")
        store.learn(state, decision)
        apply_action(data, decision)
        brain_calls += 1

        if tick % 200 == 0:
            total = brain_calls + cache_hits
            rate = cache_hits / total * 100 if total > 0 else 0
            print(f"  tick={tick}  brain={brain_calls}  cache={cache_hits}  rate={rate:.0f}%  height={state['height']:.2f}")

    print("[SCP MuJoCo Ant] Visual mode -- close the window to exit")
    print("[SCP MuJoCo Ant] Stats print every 200 ticks\n")

    with mujoco.viewer.launch_passive(model, data) as viewer:
        while viewer.is_running():
            controller(model, data)
            mujoco.mj_step(model, data)
            viewer.sync()
            time.sleep(1.0 / 50)

    store.save()
    print(f"\nFinal: brain={brain_calls} cache={cache_hits}")

if __name__ == "__main__":
    main()
