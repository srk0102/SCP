// SCPAdapter -- base class for any embodied system
// Subclass this to build an adapter for any body (game NPC, robot, car, drone).
// The adapter owns the reflex layer, muscle layer, and bridge to brain.

const { PatternStore } = require("./pattern-store");

class SCPAdapter {
  /**
   * @param {object} opts
   * @param {object} opts.embodiment - embodiment config (or path to embodiment.json)
   * @param {object} [opts.bridge] - SCPBridge instance for brain calls
   * @param {object} [opts.transport] - transport layer (WebSocket, MQTT, etc.)
   * @param {object} [opts.patternStore] - PatternStore options or instance
   */
  constructor(opts = {}) {
    this.embodiment = opts.embodiment || {};
    this.bridge = opts.bridge || null;
    this.transport = opts.transport || null;

    // Pattern store: accept an instance or options to create one
    if (opts.patternStore instanceof PatternStore) {
      this.patternStore = opts.patternStore;
    } else {
      this.patternStore = new PatternStore(opts.patternStore || {});
    }

    // Reflex rules: array of { name, test, action }
    this._reflexes = [];

    // State
    this._running = false;
    this._tickRate = opts.tickRate || 16; // ~60fps default
  }

  // -- Reflex layer --
  // Register a hardcoded instant rule. Reflexes run before muscle/brain.
  // test(state) => boolean, action(state) => void

  reflex(name, test, action) {
    if (typeof test === "function" && action === undefined) {
      // Single-arg form: reflex("name", (state) => { if (...) ... })
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

  // -- Feature extractor --
  // Override this or pass featureExtractor to PatternStore opts.

  features(extractor) {
    this.patternStore.featureExtractor = extractor;
  }

  // -- Lifecycle --

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

  // Override these in subclasses
  onStart() {}
  onStop() {}
  onTick(state) {}

  // -- Run loop --
  // Subclasses typically override onTick or use their own loop.
  // This is a convenience for simple adapters.

  async run() {
    await this.start();
    while (this._running) {
      await new Promise(r => setTimeout(r, this._tickRate));
    }
  }
}

module.exports = { SCPAdapter };
