# scp-protocol

Real-time AI execution runtime for embodied systems.

**In MCP the brain asks. In SCP the muscle asks.**

## Install

```bash
npm install scp-protocol
```

Zero external services. Zero configuration. Works immediately.

## What it does

SCP connects any LLM to any body -- physical or virtual -- without retraining. The muscle layer runs at 60fps. The brain sleeps until needed. Brain calls drop to near-zero as the pattern store learns.

## Quick start

```javascript
const { PatternStore, SCPAdapter, OllamaBridge } = require('scp-protocol')

const store = new PatternStore({
  featureExtractor: (entity) => ({
    kind: entity.kind,
    speed: entity.speed > 5 ? 'fast' : 'slow',
  }),
  storage: 'memory',
})

const adapter = new SCPAdapter({ patternStore: store })

// Reflex: fires before cache or brain, 0-5ms
adapter.reflex('emergency', (state) => {
  if (state.distance < 5) return true
})

// Muscle loop
for (const entity of entities) {
  const cached = store.lookup(entity)
  if (cached) {
    // Cache hit: act locally, zero cost
    execute(cached.decision)
  } else {
    // Cache miss: ask brain, learn for next time
    const decision = await brain.invoke(entity)
    store.learn(entity, decision)
    execute(decision)
  }
}
```

## Modules

| Module | What it does |
|--------|-------------|
| **PatternStore** | Muscle memory. Similarity matching, confidence scoring, exploration rate. |
| **SCPAdapter** | Base class for any body. Reflex layer, lifecycle hooks. |
| **SCPBridge** | Base class for any LLM. Timing, stats, error tracking. |
| **BedrockBridge** | AWS Nova Micro, Claude via Bedrock. |
| **OllamaBridge** | Local models (llama3.2, mistral). Free. |
| **OpenAIBridge** | GPT-4o, GPT-4o-mini. |
| **WebSocketTransport** | Browser and desktop adapters. |
| **HTTPTransport** | Hardware adapters, cross-language (Python). |

## Proven results

| Adapter | Physics | Cache rate |
|---------|---------|------------|
| Missile Defense | 2D canvas | ~100% |
| Self-Driving Car | 2D canvas | ~90% |
| 10-Lane Highway | 2D canvas | ~90% |
| MuJoCo Cart-Pole | Real 3D physics | 89% |
| MuJoCo Ant | Real 3D physics | 85% |

5 adapters, 2 languages (JS + Python), same protocol. Brain calls drop to near-zero in all cases.

## Tests

```bash
npm test  # 76 tests, 0 failures
```

## Links

- **GitHub:** https://github.com/srk0102/SCP
- **Docs:** https://srk-e37e8aa3.mintlify.app

## License

MIT
