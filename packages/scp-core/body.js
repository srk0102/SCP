// SCPBody -- v0.2 base class for embodied AI bodies.
//
// A body is a class. Tools are its async methods. Static `tools` declares
// the schema the brain sees. By default the body is INPROCESS: no port,
// no transport configuration. The orchestrator (Plexa) calls methods
// directly with zero serialization.
//
// To run a body in a separate process or on a different machine, mark
// it explicitly:
//
//   class MuJoCoCartpole extends SCPBody {
//     static transport = "http";
//     static port = 8002;
//     static host = "localhost";
//   }
//
// Plexa reads these static fields when registering the body and switches
// to network mode automatically. Developer intent is explicit.

const PRIORITY = { CRITICAL: 0, HIGH: 1, NORMAL: 2, LOW: 3 };
const VALID_PRIORITIES = new Set(Object.keys(PRIORITY));

class SCPBody {
  /**
   * Static fields a subclass may override:
   *   static bodyName = "cartpole"           // optional, defaults to class name
   *   static transport = "inprocess"          // "inprocess" | "http"
   *   static host = null                      // only when transport="http"
   *   static port = null                      // only when transport="http"
   *   static tools = { ... }                  // tool registry
   */
  constructor(opts = {}) {
    const Class = this.constructor;

    this.name = opts.name || Class.bodyName || Class.name;
    if (!this.name) throw new Error("SCPBody: name required");

    // Transport defaults to inprocess. Network is OPT-IN.
    this.transport = opts.transport || Class.transport || "inprocess";
    if (this.transport !== "inprocess" && this.transport !== "http") {
      throw new Error(`SCPBody ${this.name}: invalid transport "${this.transport}"`);
    }

    this.host = opts.host || Class.host || null;
    this.port = opts.port || Class.port || null;

    if (this.transport === "http" && !this.port) {
      throw new Error(`SCPBody ${this.name}: transport=http requires a port`);
    }

    // Optional pattern store + last cached entity for outcome reporting
    this.patternStore = opts.patternStore || null;
    // Optional adaptive memory: similarity-based generalization layer that
    // sits between the pattern store and the LLM brain.
    this.adaptiveMemory = opts.adaptiveMemory || null;
    this._lastCachedEntity = null;
    this._lastMemoryEntity = null;

    this.space = null;
    this.mode = "standalone";

    this._state = {
      status: "idle",
      mode: this.mode,
      pending_events: [],
      updated_at: Date.now(),
      data: {},
    };

    this.stats = {
      ticks: 0,
      toolCalls: 0,
      toolErrors: 0,
      events: 0,
      reports: 0,
    };
  }

  // -- Tool discovery --

  static tools = {};

  getToolDefinitions() {
    return this.constructor.tools || {};
  }

  /**
   * Direct tool invocation. Used by Plexa for inprocess bodies.
   * Network bodies override this to make an HTTP call instead.
   *
   * If a pattern store is attached and evaluateOutcome is overridden,
   * the result is automatically reported back to the cache after the
   * tool runs. Subclasses may also remember the entity that produced
   * the cached decision via rememberCachedEntity().
   */
  async invokeTool(toolName, parameters = {}) {
    const tools = this.getToolDefinitions();
    if (!tools[toolName]) throw new Error(`${this.name}: unknown tool "${toolName}"`);
    const fn = this[toolName];
    if (typeof fn !== "function") throw new Error(`${this.name}: tool "${toolName}" declared but no method`);
    this.stats.toolCalls++;
    try {
      const result = await fn.call(this, parameters || {});
      this._maybeReportOutcome();
      return result;
    } catch (e) {
      this.stats.toolErrors++;
      throw e;
    }
  }

  /**
   * Subclass calls this when it consumes a cached decision so the body
   * can later report the outcome back to the pattern store.
   */
  rememberCachedEntity(entity) {
    this._lastCachedEntity = entity;
  }

  /**
   * Decide locally via the pattern store and notify the orchestrator.
   *
   * The body is intelligent in BOTH standalone and managed modes. In
   * managed mode the body still uses its pattern store to decide --
   * it just tells the orchestrator what it decided so Plexa can build
   * vertical memory and learn from body-local choices.
   *
   * @param {*} entity - input to feature extractor
   * @returns { decision, source, confidence } from pattern store, or null on miss
   */
  decideLocally(entity) {
    // Layer 2: PatternStore (exact / very-similar).
    if (this.patternStore) {
      const hit = this.patternStore.lookup(entity);
      if (hit) {
        this._lastCachedEntity = entity;
        this.notifyDecision(entity, hit.decision, { source: hit.source || "cache", confidence: hit.confidence });
        return hit;
      }
    }
    // Layer 3: AdaptiveMemory (similarity-based generalization).
    if (this.adaptiveMemory) {
      const features = this.patternStore && typeof this.patternStore.features === "function"
        ? this.patternStore.features(entity)
        : (entity && typeof entity === "object" ? entity : { v: entity });
      const mem = this.adaptiveMemory.lookup(features);
      if (mem) {
        this._lastMemoryEntity = { features };
        this.notifyDecision(entity, mem.decision, { source: "adaptive", confidence: mem.confidence });
        return { decision: mem.decision, confidence: mem.confidence, source: "adaptive" };
      }
    }
    return null;
  }

  /**
   * Record a brain-sourced decision into the pattern store and the
   * adaptive memory. Call this after an LLM reply so both layers can
   * learn from it.
   */
  learnFromBrain(entity, decision) {
    if (this.patternStore && typeof this.patternStore.learn === "function") {
      this.patternStore.learn(entity, decision);
    }
    if (this.adaptiveMemory && typeof this.adaptiveMemory.store === "function") {
      const features = this.patternStore && typeof this.patternStore.features === "function"
        ? this.patternStore.features(entity)
        : (entity && typeof entity === "object" ? entity : { v: entity });
      this.adaptiveMemory.store(features, decision);
    }
  }

  /**
   * Report a body-local decision up to the orchestrator.
   * Direct function call (zero HTTP in-process).
   * The orchestrator records this for vertical memory / analytics.
   * Safe to call without an attached Space.
   */
  notifyDecision(entity, decision, meta = {}) {
    if (!this.space || typeof this.space.onBodyDecision !== "function") return;
    this.space.onBodyDecision(this.name, entity, decision, meta);
  }

  /**
   * Override in subclass to evaluate whether the current state means
   * the last cached decision succeeded. Return true (success), false
   * (failure), or null (unknown -- skip reporting).
   */
  evaluateOutcome(/* state */) { return null; }

  _maybeReportOutcome() {
    let outcome = null;
    try { outcome = this.evaluateOutcome(this._state.data); }
    catch { return; }
    if (outcome !== true && outcome !== false) return;

    if (this.patternStore && this._lastCachedEntity) {
      this.patternStore.report(this._lastCachedEntity, outcome);
      this.stats.reports++;
      if (outcome) this._lastCachedEntity = null;
    }
    if (this.adaptiveMemory && this._lastMemoryEntity) {
      this.adaptiveMemory.report(this._lastMemoryEntity.features, outcome);
      if (outcome) this._lastMemoryEntity = null;
    }
  }

  // -- Space attachment --

  _attachSpace(space) {
    if (this.space && this.space !== space) {
      throw new Error(`${this.name}: already attached to a Space`);
    }
    this.space = space;
    this._setMode("managed");
  }

  _detachSpace() {
    this.space = null;
    this._setMode("standalone");
  }

  _setMode(mode) {
    if (mode !== "standalone" && mode !== "managed") {
      throw new Error(`${this.name}: invalid mode "${mode}"`);
    }
    this.mode = mode;
    this._state.mode = mode;
    this._state.updated_at = Date.now();
  }

  // -- Lifecycle (override in subclass) --

  async onConfigure() { this._setStatus("configured"); }
  async onActivate()  { this._setStatus("active"); }
  async onEmergencyStop() { this._setStatus("stopped"); }

  /**
   * Sensor loop. Called by Space at tickHz for inprocess bodies.
   * For network bodies, the body's own process owns its tick loop.
   */
  async tick() { this.stats.ticks++; }

  // -- State --

  snapshot() {
    return {
      status: this._state.status,
      mode: this._state.mode,
      transport: this.transport,
      pending_events: [...this._state.pending_events],
      updated_at: this._state.updated_at,
      ...this._state.data,
    };
  }

  setState(patch) {
    Object.assign(this._state.data, patch);
    this._state.updated_at = Date.now();
  }

  _setStatus(status) {
    this._state.status = status;
    this._state.updated_at = Date.now();
  }

  emit(eventType, payload = {}, priority = "NORMAL") {
    if (!VALID_PRIORITIES.has(priority)) priority = "NORMAL";
    this._state.pending_events.push({ type: eventType, payload, priority, ts: Date.now() });
    this.stats.events++;

    if (this._state.pending_events.length > 20) {
      const recent = this._state.pending_events.slice(-20);
      const droppedCritical = this._state.pending_events
        .slice(0, -20)
        .filter((e) => e.priority === "CRITICAL");
      this._state.pending_events = [...droppedCritical, ...recent];
    }

    if (this.space) {
      this.space.onBodyEvent(this.name, eventType, payload, priority);
    }
  }

  clearPendingEvents() { this._state.pending_events = []; }

  /**
   * Install graceful shutdown handlers for this body so its pattern store
   * (and adaptive memory if present) are persisted on SIGINT / SIGTERM.
   * Idempotent. Call once in standalone-mode bodies. In managed mode the
   * Space handles the save on its own stop().
   */
  installShutdownHandlers() {
    if (this._shutdownInstalled) return this;
    this._shutdownInstalled = true;
    const save = (signal) => {
      try {
        if (this.patternStore && typeof this.patternStore.save === "function") {
          this.patternStore.save();
          const n = this.patternStore.patterns ? this.patternStore.patterns.size : 0;
          console.log(`[scp] patterns saved (${n} entries)`);
        }
      } catch {}
      try {
        if (this.adaptiveMemory && typeof this.adaptiveMemory.save === "function") {
          const n = this.adaptiveMemory.save();
          if (typeof n === "number") console.log(`[scp] adaptive memory saved (${n} entries)`);
        }
      } catch {}
      process.exit(signal === "SIGINT" ? 130 : 143);
    };
    process.once("SIGINT",  () => save("SIGINT"));
    process.once("SIGTERM", () => save("SIGTERM"));
    return this;
  }
}

module.exports = { SCPBody, PRIORITY };
