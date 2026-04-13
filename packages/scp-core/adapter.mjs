// SCPAdapter -- base class for any embodied system (ESM)

import { PatternStore } from "./pattern-store.mjs";

export class SCPAdapter {
  constructor(opts = {}) {
    this.embodiment = opts.embodiment || {};
    this.bridge = opts.bridge || null;
    this.transport = opts.transport || null;

    if (opts.patternStore instanceof PatternStore) {
      this.patternStore = opts.patternStore;
    } else {
      this.patternStore = new PatternStore(opts.patternStore || {});
    }

    this._reflexes = [];
    this._running = false;
    this._tickRate = opts.tickRate || 16;
  }

  reflex(name, test, action) {
    if (typeof test === "function" && action === undefined) {
      this._reflexes.push({ name, handler: test });
    } else {
      this._reflexes.push({ name, test, action });
    }
  }

  _runReflexes(state) {
    for (const r of this._reflexes) {
      if (r.handler) {
        r.handler(state);
      } else if (r.test(state)) {
        r.action(state);
        return { handled: true, reflex: r.name };
      }
    }
    return { handled: false };
  }

  features(extractor) {
    this.patternStore.featureExtractor = extractor;
  }

  async start() {
    this._running = true;
    this.patternStore.load();
    this.onStart();
  }

  stop() {
    this._running = false;
    this.patternStore.save();
    this.onStop();
  }

  onStart() {}
  onStop() {}
  onTick(state) {}

  async run() {
    await this.start();
    while (this._running) {
      await new Promise(r => setTimeout(r, this._tickRate));
    }
  }
}
