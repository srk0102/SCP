// OpenAIBridge -- OpenAI API (GPT-4o, GPT-4o-mini, etc.)
// Requires: OPENAI_API_KEY environment variable

const { SCPBridge } = require("../bridge");
const https = require("node:https");

class OpenAIBridge extends SCPBridge {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - OpenAI model, default "gpt-4o-mini"
   * @param {string} [opts.apiKey] - API key, default from OPENAI_API_KEY env
   * @param {string} [opts.systemPrompt] - system prompt text
   * @param {number} [opts.maxTokens] - default 512
   * @param {number} [opts.temperature] - default 0.1
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "gpt-4o-mini";
    this.apiKey = opts.apiKey || process.env.OPENAI_API_KEY;
  }

  async call(prompt, tools) {
    if (!this.apiKey) {
      throw new Error("OpenAIBridge: no API key. Set OPENAI_API_KEY or pass apiKey in constructor.");
    }

    const messages = [];
    if (this.systemPrompt) {
      messages.push({ role: "system", content: this.systemPrompt });
    }
    messages.push({ role: "user", content: JSON.stringify(prompt) });

    const body = JSON.stringify({
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    const raw = await this._post(body);
    const parsed = JSON.parse(raw);

    if (parsed.error) {
      throw new Error(`OpenAI API error: ${parsed.error.message}`);
    }

    const content = parsed.choices?.[0]?.message?.content || "";

    let decision = content;
    try {
      decision = JSON.parse(content);
    } catch {}

    return { decision, raw: parsed };
  }

  _post(body) {
    return new Promise((resolve, reject) => {
      const req = https.request("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
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

module.exports = { OpenAIBridge };
