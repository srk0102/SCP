// HTTPTransport -- simple REST for hardware adapters
// Best for: Raspberry Pi, ESP32, any device that can make HTTP requests.
// No WebSocket dependency. Just POST and GET.

const { SCPTransport } = require("./base");
const http = require("node:http");

class HTTPTransport extends SCPTransport {
  /**
   * @param {object} opts
   * @param {number} [opts.port] - HTTP port, default 3000
   */
  constructor(opts = {}) {
    super({ ...opts, port: opts.port || 3000 });
    this._server = null;
    this._pendingResponses = []; // queued messages for GET /poll
  }

  async start() {
    this._server = http.createServer((req, res) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // POST /emit -- muscle sends a message
      if (req.method === "POST" && req.url === "/emit") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          try {
            const msg = JSON.parse(body);
            if (msg && msg.type) {
              this._dispatch(msg.type, msg);
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: e.message }));
          }
        });
        return;
      }

      // GET /poll -- muscle polls for queued messages from brain
      if (req.method === "GET" && req.url === "/poll") {
        const messages = this._pendingResponses.splice(0);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages }));
        return;
      }

      // GET /health
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", port: this.port }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    this._server.listen(this.port);
    this._connected = true;
    console.log(`[http-transport] listening on http://localhost:${this.port}`);
  }

  emit(type, data) {
    this._pendingResponses.push({ type, ...data });
  }

  async stop() {
    if (this._server) {
      this._server.close();
      this._server = null;
    }
    this._connected = false;
  }
}

module.exports = { HTTPTransport };
