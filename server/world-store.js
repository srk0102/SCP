// Shared in-memory store. The MCP server reads/writes here. The WebSocket
// bridge reads/writes here. Single source of truth for the brain's view of
// the world. Owned by the SCP server, NOT the brain.

const SCP_VERSION = "0.1.0";

class WorldStore {
  constructor() {
    this.embodiments = new Map();      // embodiment_id -> embodiment spec
    this.worldStates = new Map();      // embodiment_id -> latest WorldState
    this.eventQueues = new Map();      // embodiment_id -> SemanticEvent[]
    this.assignmentQueues = new Map(); // embodiment_id -> BulkAssignment[]
    this.muscleSockets = new Map();    // embodiment_id -> ws connection
    this.muscleModes = new Map();      // embodiment_id -> "no-brainer" | "brainer" | "scp"
  }

  registerEmbodiment(emb) {
    this.embodiments.set(emb.embodiment_id, emb);
    if (!this.eventQueues.has(emb.embodiment_id)) this.eventQueues.set(emb.embodiment_id, []);
    if (!this.assignmentQueues.has(emb.embodiment_id)) this.assignmentQueues.set(emb.embodiment_id, []);
    return emb.embodiment_id;
  }

  setWorldState(embodiment_id, world) {
    this.worldStates.set(embodiment_id, world);
  }

  getWorldState(embodiment_id) {
    return this.worldStates.get(embodiment_id) || null;
  }

  getEmbodiment(embodiment_id) {
    return this.embodiments.get(embodiment_id) || null;
  }

  listEmbodiments() {
    return Array.from(this.embodiments.values());
  }

  enqueueEvent(embodiment_id, event) {
    const q = this.eventQueues.get(embodiment_id);
    if (!q) return;
    q.push(event);
    // Cap queue at 1000 to prevent runaway
    while (q.length > 1000) q.shift();
  }

  pollEvents(embodiment_id, since_timestamp = 0) {
    const q = this.eventQueues.get(embodiment_id) || [];
    return q.filter(e => e.timestamp > since_timestamp);
  }

  drainEvents(embodiment_id) {
    const q = this.eventQueues.get(embodiment_id) || [];
    const drained = q.slice();
    this.eventQueues.set(embodiment_id, []);
    return drained;
  }

  enqueueAssignment(embodiment_id, assignment) {
    const q = this.assignmentQueues.get(embodiment_id);
    if (!q) return false;
    q.push(assignment);
    // Forward immediately to muscle if connected
    const sock = this.muscleSockets.get(embodiment_id);
    if (sock && sock.readyState === 1) {
      sock.send(JSON.stringify({
        type: "bulk_assignment",
        scp_version: SCP_VERSION,
        assignment_id: assignment.assignment_id,
        assignments: assignment.assignments,
      }));
      return true;
    }
    return false;
  }

  setMuscleMode(embodiment_id, mode) {
    this.muscleModes.set(embodiment_id, mode);
  }

  getMuscleMode(embodiment_id) {
    return this.muscleModes.get(embodiment_id) || "scp";
  }

  attachMuscleSocket(embodiment_id, ws) {
    this.muscleSockets.set(embodiment_id, ws);
  }

  detachMuscleSocket(embodiment_id) {
    this.muscleSockets.delete(embodiment_id);
  }
}

export const store = new WorldStore();
export { SCP_VERSION };
