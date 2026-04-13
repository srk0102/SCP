// BedrockBridge -- AWS Bedrock (Nova Micro, Claude, etc.)
// Extracted from client/qwen-mcp-bridge.js
// Cost: ~$0.001 per call with Nova Micro

const { SCPBridge } = require("../bridge");

class BedrockBridge extends SCPBridge {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - Bedrock model ID, default "amazon.nova-micro-v1:0"
   * @param {string} [opts.region] - AWS region, default "us-east-1"
   * @param {string} [opts.systemPrompt] - system prompt text
   * @param {number} [opts.maxTokens] - default 512
   * @param {number} [opts.temperature] - default 0.1
   */
  constructor(opts = {}) {
    super(opts);
    this.model = opts.model || "amazon.nova-micro-v1:0";
    this.region = opts.region || process.env.AWS_REGION || "us-east-1";
    this._client = null;
  }

  _ensureClient() {
    if (this._client) return;
    const { BedrockRuntimeClient } = require("@aws-sdk/client-bedrock-runtime");
    this._client = new BedrockRuntimeClient({ region: this.region });
  }

  async call(prompt, tools) {
    this._ensureClient();
    const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

    const messages = [{ role: "user", content: [{ text: JSON.stringify(prompt) }] }];

    const params = {
      modelId: this.model,
      messages,
      inferenceConfig: { maxTokens: this.maxTokens, temperature: this.temperature },
    };

    if (this.systemPrompt) {
      params.system = [{ text: this.systemPrompt }];
    }

    if (tools && tools.length > 0) {
      params.toolConfig = { tools };
    }

    const resp = await this._client.send(new ConverseCommand(params));
    const output = resp.output?.message;

    if (!output) return { decision: null, raw: resp };

    // Check for tool use
    const toolUse = output.content?.find(b => b.toolUse);
    if (toolUse) {
      return { decision: toolUse.toolUse.input, raw: resp };
    }

    // Text response
    const text = output.content?.find(b => b.text);
    return { decision: text?.text || null, raw: resp };
  }
}

module.exports = { BedrockBridge };
