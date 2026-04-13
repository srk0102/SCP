// SCPTransport -- base class for transport layers
// Subclass this to connect muscle to bridge over any protocol.

class SCPTransport {
  constructor(opts = {}) {
    this.port = opts.port || 7777;
    this._connected = false;
    this._handlers = new Map();
  }

  // Register a handler for a message type
  on(type, handler) {
    this._handlers.set(type, handler);
  }

  // Emit a message to connected peers
  emit(type, data) {
    throw new Error("SCPTransport.emit() must be implemented by subclass");
  }

  // Start listening
  async start() {
    throw new Error("SCPTransport.start() must be implemented by subclass");
  }

  // Stop and clean up
  async stop() {
    throw new Error("SCPTransport.stop() must be implemented by subclass");
  }

  _dispatch(type, data) {
    const handler = this._handlers.get(type);
    if (handler) handler(data);
  }
}

module.exports = { SCPTransport };
