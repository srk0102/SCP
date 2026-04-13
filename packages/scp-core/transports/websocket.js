// WebSocketTransport -- browser and desktop adapters
// Extracted from server/ws-bridge.js
// Requires: ws package (already a dependency of the server)

const { SCPTransport } = require("./base");

class WebSocketTransport extends SCPTransport {
  /**
   * @param {object} opts
   * @param {number} [opts.port] - WebSocket port, default 7777
   */
  constructor(opts = {}) {
    super(opts);
    this._wss = null;
    this._clients = new Set();
  }

  async start() {
    const { WebSocketServer } = require("ws");
    this._wss = new WebSocketServer({ port: this.port });
    this._connected = true;

    this._wss.on("connection", (ws) => {
      this._clients.add(ws);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg && msg.type) {
            this._dispatch(msg.type, msg);
          }
        } catch {}
      });

      ws.on("close", () => {
        this._clients.delete(ws);
      });
    });

    console.log(`[ws-transport] listening on ws://localhost:${this.port}`);
  }

  emit(type, data) {
    const msg = JSON.stringify({ type, ...data });
    for (const ws of this._clients) {
      if (ws.readyState === 1) { // WebSocket.OPEN
        ws.send(msg);
      }
    }
  }

  async stop() {
    if (this._wss) {
      for (const ws of this._clients) ws.close();
      this._clients.clear();
      this._wss.close();
      this._wss = null;
    }
    this._connected = false;
  }
}

module.exports = { WebSocketTransport };
