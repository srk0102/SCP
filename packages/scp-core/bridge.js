// SCPBridge -- base class for connecting to any LLM
// Subclass this to build a bridge for Bedrock, OpenAI, Ollama, etc.
// The bridge handles: waking the brain, sending context, receiving intent.

class SCPBridge {
  /**
   * @param {object} opts
   * @param {string} [opts.model] - model identifier
   * @param {number} [opts.maxTokens] - max response tokens, default 512
   * @param {number} [opts.temperature] - sampling temperature, default 0.1
   * @param {string} [opts.systemPrompt] - system prompt text
   */
  constructor(opts = {}) {
    this.model = opts.model || null;
    this.maxTokens = opts.maxTokens || 512;
    this.temperature = opts.temperature ?? 0.1;
    this.systemPrompt = opts.systemPrompt || "";

    // Stats
    this.callCount = 0;
    this.errorCount = 0;
    this.lastCallMs = 0;
  }

  // -- Override in subclasses --
  // Must return { decision, raw } where decision is the parsed intent
  // and raw is the full LLM response for logging.

  async call(prompt, tools) {
    throw new Error("SCPBridge.call() must be implemented by subclass");
  }

  // -- Convenience wrapper with timing --

  async invoke(prompt, tools) {
    const start = Date.now();
    try {
      const result = await this.call(prompt, tools);
      this.callCount++;
      this.lastCallMs = Date.now() - start;
      return result;
    } catch (e) {
      this.errorCount++;
      this.lastCallMs = Date.now() - start;
      throw e;
    }
  }

  stats() {
    return {
      calls: this.callCount,
      errors: this.errorCount,
      lastCallMs: this.lastCallMs,
    };
  }
}

module.exports = { SCPBridge };
