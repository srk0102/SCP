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
   */
  async invokeTool(toolName, parameters = {}) {
    const tools = this.getToolDefinitions();
    if (!tools[toolName]) throw new Error(`${this.name}: unknown tool "${toolName}"`);
    const fn = this[toolName];
    if (typeof fn !== "function") throw new Error(`${this.name}: tool "${toolName}" declared but no method`);
    this.stats.toolCalls++;
    try {
      return await fn.call(this, parameters || {});
    } catch (e) {
      this.stats.toolErrors++;
      throw e;
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
}

module.exports = { SCPBody, PRIORITY };
