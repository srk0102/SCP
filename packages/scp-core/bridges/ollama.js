// OllamaBridge -- local models via Ollama
// Free, zero API cost, runs on your machine.
// Requires: ollama installed and running (ollama serve)

const { SCPBridge } = require("../bridge");
const http = require("node:http");

class OllamaBridge extends SCPBridge {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - Ollama model name, default "llama3.2"
   * @param {string} [opts.host] - Ollama API host, default "http://localhost:11434"
   * @param {string} [opts.systemPrompt] - system prompt text
   * @param {number} [opts.maxTokens] - default 512
   * @param {number} [opts.temperature] - default 0.1
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "llama3.2";
    this.host = opts.host || "http://localhost:11434";
  }

  async call(prompt, tools) {
    const url = new URL("/api/chat", this.host);

    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push({ role: "user", content: JSON.stringify(prompt) });

    const body = JSON.stringify({
      model: this.model,
      messages,
      stream: false,
      options: {
        temperature: this.temperature,
        num_predict: this.maxTokens,
      },
    });

    const raw = await this._post(url, body);
    const parsed = JSON.parse(raw);
    const content = parsed.message?.content || "";

    // Try to parse JSON from the response
    let decision = content;
    try {
      decision = JSON.parse(content);
    } catch {}

    return { decision, raw: parsed };
  }

  _post(url, body) {
    return new Promise((resolve, reject) => {
      const req = http.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }, (res) => {
        let data = "";
        res.on("data", chunk => { data += chunk; });
        res.on("end", () => resolve(data));
      });
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = { OllamaBridge };
