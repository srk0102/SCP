# scp-protocol

Real-time execution runtime for embodied AI. An `SCPBody` runs a tick loop, keeps its own pattern cache, and delegates to an LLM only when the cache misses.

```bash
npm install scp-protocol
```

Node >= 18. One production dependency: `better-sqlite3` (for pattern persistence). LLM bridges and network transports are optional peer deps, installed only when you use them.

---

## What it does

- Split control into three layers with different latency budgets: reflex (in-body, sub-millisecond), muscle (local pattern cache, microseconds), brain (LLM, hundreds of milliseconds).
- Cache brain decisions keyed by feature vectors, replay them locally when the same situation recurs, invalidate them when outcomes stop matching.
- Provide one base class (`SCPBody`) that works both standalone (body owns an LLM) and managed (an orchestrator such as [Plexa](https://www.npmjs.com/package/@srk0102/plexa) owns the LLM). The body keeps its local cache in both modes.

It does not ship an agent framework, a planner, or a safety layer. It is a caching layer around LLM tool calls, with a tick-loop body contract.

---

## Install

```bash
npm install scp-protocol
```

Optional peer dependencies, install only if you use them:

```bash
npm install ws                                # for WebSocketTransport
npm install @aws-sdk/client-bedrock-runtime   # for BedrockBridge
```

Ollama and OpenAI bridges use only `node:http`/`node:https` and require no extra packages.

---

## Quick start

```javascript
const { SCPBody, PatternStore } = require("scp-protocol")
const { OllamaBridge }          = require("scp-protocol/bridges/ollama")

class PatrolBody extends SCPBody {
  static bodyName = "patrol"
  static tools = {
    halt:    { description: "stop motion",  parameters: {} },
    advance: {
      description: "move forward",
      parameters: { speed: { type: "number", min: 0, max: 1, required: true } },
    },
  }

  async halt()              { /* drive hardware */ }
  async advance({ speed })  { /* drive hardware */ }
}

const store = new PatternStore({
  featureExtractor: (entity) => ({ kind: entity.kind, close: entity.distance < 5 }),
  failureThreshold: 3,   // auto-invalidate a cached pattern after 3 consecutive failures
})

const body = new PatrolBody({ patternStore: store, brain: new OllamaBridge({ model: "llama3.2" }) })

// After every action resolves:
store.report(entity, succeeded)   // true or false
```

That is the full surface the body code touches. Pattern lookup and brain fallback happen inside the body.

---

## PatternStore

A feature-keyed cache for brain decisions.

| Operation     | What it does                                                                    |
|---------------|----------------------------------------------------------------------------------|
| `lookup`      | Exact-hash match, falls back to k-NN similarity over numeric/string/bool fields. |
| `learn`       | Store a decision against an entity's feature vector. Bumps count on repeat.      |
| `report`      | Record outcome for the last served pattern. Tracks consecutive failures.         |
| `save`/`load` | Persist via localStorage (browser) or SQLite (Node, via `better-sqlite3`).       |

Tunables: `similarityThreshold`, `explorationRate` (epsilon-greedy), `maxPatterns` (LRU-ish eviction by hit count), `failureThreshold`.

Emits: `pattern_invalidated` when a pattern crosses the failure threshold.

`stats()` returns: `hits`, `misses`, `explorations`, `corrections`, `invalidations`, `totalReports`, `totalSuccesses`, `totalFailures`, `averageSuccessRate`, `lowConfidencePatterns`, `hitRate`.

---

## SCPBody

A body is a class with a static tools map and one async method per tool.

```javascript
class Arm extends SCPBody {
  static bodyName = "arm"
  static transport = "inprocess"   // default. Set "http" to run the body in another process.
  static tools = {
    grasp:  { description: "close gripper", parameters: {} },
    move:   {
      description: "move end-effector",
      parameters: {
        x: { type: "number", required: true },
        y: { type: "number", required: true },
      },
    },
  }

  async grasp()        { /* ... */ }
  async move({ x, y }) { /* ... */ }

  async tick() {
    // sensor read loop, called by whoever drives the body
    await super.tick()
    this.setState({ pose: readJointAngles() })
  }

  // Override to auto-report outcomes after every tool call.
  evaluateOutcome(state) {
    return state.pose_error < 0.01
  }
}
```

`invokeTool(name, params)` calls the method, records an outcome against the last cached entity, and returns the result.

### Modes

| Mode         | Who calls the LLM       | Pattern store | Reflex |
|--------------|-------------------------|---------------|--------|
| standalone   | the body                | local         | local  |
| managed      | an orchestrator (Plexa) | local         | local  |

In managed mode the body still consults its local cache on every decision it makes. It notifies the orchestrator of local decisions; it does not defer to the orchestrator for them.

---

## Bridges

| Bridge           | Package needed                      | Models                          |
|------------------|-------------------------------------|---------------------------------|
| `OllamaBridge`   | none (uses `node:http`)             | any local ollama model          |
| `OpenAIBridge`   | none (uses `node:https`)            | `gpt-4o`, `gpt-4o-mini`         |
| `BedrockBridge`  | `@aws-sdk/client-bedrock-runtime`   | Nova Micro, Claude via Bedrock  |

All bridges extend `SCPBridge`, which tracks call count, total time, average latency, and errors.

---

## Transports

| Transport            | Package needed | Purpose                                            |
|----------------------|----------------|----------------------------------------------------|
| (default, none)      | —              | Body methods are called directly (zero HTTP).      |
| `HTTPTransport`      | none           | Body exposes `/emit`, `/poll`, `/health` over HTTP.|
| `WebSocketTransport` | `ws`           | Full-duplex stream between body and controller.    |

A body declares `static transport = "http"` and a `static port` to opt into a transport. Otherwise it is in-process.

---

## Working with Plexa

Drop an `SCPBody` into a Plexa `Space` to put one LLM in front of several bodies:

```javascript
const { Space } = require("@srk0102/plexa")
const { SCPBody } = require("scp-protocol")

class Arm    extends SCPBody { /* ... */ }
class Camera extends SCPBody { /* ... */ }

const space = new Space("pick_and_place")
space.addBody(new Arm())
space.addBody(new Camera())
await space.run()
```

Each body keeps its own pattern store and decides at muscle speed; Plexa handles brain-tier calls and cross-body coordination.

---

## Tests

```bash
npm test
```

112 tests across 9 suites. Built-in `node:test`, no test framework dependency.

| Suite                  | Tests |
|------------------------|------:|
| pattern-store          | 23 |
| success-rate           | 28 |
| adapter                | 14 |
| bridge                 | 10 |
| bridges                | 10 |
| transports             | 10 |
| managed-mode           |  8 |
| integration            |  7 |
| persistence            |  5 |

`persistence.test.js` is skipped automatically if `better-sqlite3` fails to build on the host.

---

## What is not in this package

So you do not have to go looking:

- No multi-body orchestrator. See [`@srk0102/plexa`](https://www.npmjs.com/package/@srk0102/plexa).
- No safety gate above the body's own reflexes.
- No vertical / cross-session memory. The pattern store is per-body.
- No Python client. SCP bodies written in Python coordinate via `HTTPTransport`.
- No CRDT or cross-body shared state.

---

## Links

- Source: https://github.com/srk0102/SCP
- npm: https://npmjs.com/package/scp-protocol
- Orchestrator: https://npmjs.com/package/@srk0102/plexa

## License

MIT
