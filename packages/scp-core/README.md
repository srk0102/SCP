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

Orchestrating multiple bodies? Use [`@srk0102/plexa`](https://github.com/srk0102/plexa) on top of `scp-protocol`.

## Quick start

```javascript
const { PatternStore, SCPBody, OllamaBridge } = require('scp-protocol')

class PatrolBody extends SCPBody {
  static bodyName = 'patrol'
  static tools = {
    halt:      { description: 'stop motion',       parameters: {} },
    advance:   { description: 'move forward',      parameters: { speed: { type: 'number', min: 0, max: 1 } } },
  }
  async halt()              { /* ... */ }
  async advance({ speed })  { /* ... */ }
}

// Pattern store with outcome reporting (v0.3)
const store = new PatternStore({
  featureExtractor: (e) => ({ kind: e.kind, close: e.distance < 5 }),
  failureThreshold: 3,      // auto-invalidate after 3 consecutive failures
})

const body = new PatrolBody({ patternStore: store })

// After a cached decision executes, report the outcome
store.report(entity, success)    // success=true or false
```

## Modules

| Module | What it does |
|--------|-------------|
| **PatternStore** | Muscle memory. Similarity, confidence, exploration, **success-rate monitoring with auto-invalidation**. |
| **SCPBody** *(v0.2+)* | Class-based body. Tools are methods. Intelligent in both standalone and managed modes. |
| **SCPAdapter** | Legacy base class (v0.1, kept for back-compat). Reflex layer, lifecycle hooks. |
| **SCPBridge** | Base class for any LLM. Timing, stats, error tracking. |
| **BedrockBridge** | AWS Nova Micro, Claude via Bedrock. |
| **OllamaBridge** | Local models (llama3.2, mistral). Free. |
| **OpenAIBridge** | GPT-4o, GPT-4o-mini. |
| **WebSocketTransport** | Browser and desktop adapters. |
| **HTTPTransport** | Hardware adapters, cross-language (Python). |

## Works with Plexa

[Plexa](https://github.com/srk0102/plexa) is the orchestration framework above SCP:

```bash
npm install @srk0102/plexa
```

An `SCPBody` drops straight into a Plexa `Space`. One LLM brain coordinates many bodies, each still using its local pattern store at muscle speed.

```javascript
const { Space, OllamaBrain } = require('@srk0102/plexa')
const { SCPBody } = require('scp-protocol')

class ArmBody extends SCPBody { /* tools ... */ }
class CameraBody extends SCPBody { /* tools ... */ }

const space = new Space('pick_and_place')
space.addBody(new ArmBody())
space.addBody(new CameraBody())
space.setBrain(new OllamaBrain({ model: 'llama3.2' }))
await space.run()
```

| Use | Package |
|-----|---------|
| One body, one brain | `scp-protocol` |
| Many bodies, one brain | `@srk0102/plexa` (built on scp-protocol) |

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
npm test  # 112 tests, 0 failures
```

## Links

- **GitHub:** https://github.com/srk0102/SCP
- **Docs:** https://srk-e37e8aa3.mintlify.app
- **Plexa (multi-body orchestration):** https://github.com/srk0102/plexa

## License

MIT
