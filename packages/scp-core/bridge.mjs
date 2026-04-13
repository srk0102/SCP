// SCPBridge -- base class for connecting to any LLM (ESM)

export class SCPBridge {
  constructor(opts = {}) {
    this.model = opts.model || null;
    this.maxTokens = opts.maxTokens || 512;
    this.temperature = opts.temperature ?? 0.1;
    this.systemPrompt = opts.systemPrompt || "";

    this.callCount = 0;
    this.errorCount = 0;
    this.lastCallMs = 0;
  }

  async call(prompt, tools) {
    throw new Error("SCPBridge.call() must be implemented by subclass");
  }

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
