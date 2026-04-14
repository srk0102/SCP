<p align="center">
  <img src="https://raw.githubusercontent.com/srk0102/SCP/master/assets/logo.svg" width="140" height="140" alt="SCP"/>
</p>

<h1 align="center">scp-protocol</h1>

<p align="center">
  Any LLM. Any continuously running system.
  <br/>
  Brain teaches once. System remembers forever.
</p>

<p align="center">
  SCP is not just for robots. Any system that runs continuously and
  occasionally needs an LLM to intervene can use SCP. Game NPCs. Robot
  arms. Web backends. Simulation agents. Animation rigs. If it runs in
  a loop and pushes state, SCP connects it to any LLM.
</p>

<p align="center">
  <a href="https://npmjs.com/package/scp-protocol"><img src="https://img.shields.io/npm/v/scp-protocol?color=4F46E5&label=npm" alt="npm"/></a>
  <a href="https://github.com/srk0102/SCP"><img src="https://img.shields.io/github/license/srk0102/SCP?color=818CF8" alt="license"/></a>
  <a href="https://github.com/srk0102/SCP"><img src="https://img.shields.io/badge/tests-112%20passing-10B981" alt="tests"/></a>
  <a href="https://github.com/srk0102/plexa"><img src="https://img.shields.io/badge/orchestrate_with-plexa-818CF8" alt="plexa"/></a>
</p>

---

## Demo: MuJoCo cart-pole

[![Watch the demo](https://res.cloudinary.com/still-studying/video/upload/so_3/Screen_Recording_2026-04-13_010202_qlnftl.jpg)](https://res.cloudinary.com/still-studying/video/upload/Screen_Recording_2026-04-13_010202_qlnftl.mp4)

Real MuJoCo physics. The brain is asked on every cache miss; brain decisions are then cached locally so familiar situations no longer wake it. Novel situations always wake the brain. Cost is proportional to novelty.

---

## Overview

An `SCPBody` runs a tick loop and owns a four-layer decision stack. Only the top layer calls the LLM; the lower three never leave the process.

```
1. Reflex            hard rules in the body           0-5 ms
2. PatternStore      exact / very-similar cache       0.1 ms
3. AdaptiveMemory    similarity-scored generalizer    1-5 ms
4. LLM brain         novel situations only            500 ms+
```

Every LLM decision is written back to layers 2 and 3, so layer 4 gets quieter over time.

```bash
npm install scp-protocol
```

Node >= 18. One production dependency: `better-sqlite3` (for pattern persistence). LLM bridges and network transports are optional peer deps, installed only when you use them.

---

## Architecture

<p align="center">
  <img src="https://raw.githubusercontent.com/srk0102/SCP/master/assets/architecture.svg" alt="SCP architecture"/>
</p>

## Adapters

<p align="center">
  <img src="https://raw.githubusercontent.com/srk0102/SCP/master/assets/adapters-proof.svg" alt="SCP adapters"/>
</p>

<table>
<tr>
<td width="50%" align="center">
<a href="https://github.com/srk0102/SCP/blob/master/assets/missile-defense.mp4"><img src="https://raw.githubusercontent.com/srk0102/SCP/master/assets/missile-defense-thumb.png" width="320" alt="Missile Defense"/></a>
<br/><sub>Missile defense -- 10 launchers, brain classifies stealth</sub>
</td>
<td width="50%" align="center">
<a href="https://github.com/srk0102/SCP/blob/master/assets/car-simulation.mp4"><img src="https://raw.githubusercontent.com/srk0102/SCP/master/assets/car-simulation-thumb.png" width="320" alt="Self-driving car"/></a>
<br/><sub>Self-driving car -- ambulance yield, obstacle avoidance</sub>
</td>
</tr>
</table>

---

## What SCP does

SCP gives a continuously running system the ability to call an LLM only when it cannot answer locally. The body runs in a loop, holds its own decision cache, and the LLM advises only on novel situations. Brain decisions are then cached locally for next time.

It works for any system that ticks and pushes state, not just robots:

- **Game AI.** An NPC behavior loop that calls the LLM the first few times it sees a new player tactic, then handles the same tactic locally forever after.
- **Robotics.** Physical actuators at 60 fps with a slow LLM as the strategic layer.
- **Simulation.** A policy that learns from LLM decisions without retraining a model.
- **Web backends.** A server that asks the LLM how to react to a new error pattern, then handles the same pattern from cache on subsequent occurrences. See [examples/web-backend](https://srk-e37e8aa3.mintlify.app/examples/web-backend).

The body decides when the brain wakes based on confidence thresholds in the pattern store and adaptive memory. When cached decisions are confident enough the brain stays silent. When confidence drops below threshold the brain is called. Default thresholds are conservative. Tune them per use case.

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
| `lookup`      | Exact-hash match, falls back to k-NN similarity over numeric/string/bool fields. Returns `{ decision, confidence, source }` where source is `"exact"` or `"similar"`. |
| `learn`       | Store a decision against an entity's feature vector. Bumps count on repeat.      |
| `report`      | Record outcome for the last served pattern. Tracks consecutive failures.         |
| `save`/`load` | Persist via localStorage (browser) or SQLite (Node, via `better-sqlite3`).       |

Tunables: `similarityThreshold`, `explorationRate` (epsilon-greedy), `maxPatterns` (LRU-ish eviction by hit count), `failureThreshold`.

Emits: `pattern_invalidated` when a pattern crosses the failure threshold.

`stats()` returns: `hits`, `misses`, `explorations`, `corrections`, `invalidations`, `totalReports`, `totalSuccesses`, `totalFailures`, `averageSuccessRate`, `lowConfidencePatterns`, `hitRate`.

---

## AdaptiveMemory

A similarity-scored decision store that generalizes from brain decisions when the PatternStore misses. Plain JavaScript; no neural network.

```javascript
const { AdaptiveMemory } = require("scp-protocol")

const mem = new AdaptiveMemory({
  threshold: 0.8,
  k: 5,
  maxHistory: 500,
  storage: "sqlite",
  storageKey: "scp_adaptive.db",
})

mem.store(features, decision)          // record a decision
const hit = mem.lookup(features)        // returns { decision, confidence } or null
mem.report(features, success)           // reinforce / penalize; auto-purge at N failures
```

Scoring: weighted euclidean distance in normalized feature space, blended with the fraction of top-k neighbors that agree on the decision. Weights are per-feature and configurable.

Confidence decays on failure and recovers on success. After `failureThreshold` consecutive failures an entry is purged; an `entry_purged` event fires.

`stats()` returns: `entries`, `hits`, `misses`, `hitRate`, `avgConfidence`, `successReports`, `failureReports`, `purged`.

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

### Wiring all four layers

```javascript
const body = new Arm({
  patternStore:    new PatternStore({ featureExtractor: (e) => ({ kind: e.kind }) }),
  adaptiveMemory:  new AdaptiveMemory({ threshold: 0.8 }),
})

// In your tick / decide loop:
const local = body.decideLocally(entity)
if (local) {
  // Pattern or adaptive memory had a confident answer.
  execute(local.decision)
} else {
  const fromBrain = await brain.call(entity)
  body.learnFromBrain(entity, fromBrain)   // writes to both cache layers
  execute(fromBrain)
}
```

`decideLocally(entity)` returns `{ decision, confidence, source }` where `source` is `"exact"`, `"similar"`, `"adaptive"`, or `null` on miss. `learnFromBrain(entity, decision)` stores in both the PatternStore and AdaptiveMemory.

### Graceful shutdown

```javascript
body.installShutdownHandlers()   // saves patternStore + adaptiveMemory on SIGINT / SIGTERM
```

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

145 tests across 10 suites. Built-in `node:test`, no test framework dependency.

| Suite                  | Tests |
|------------------------|------:|
| pattern-store          | 23 |
| success-rate           | 28 |
| adaptive-memory        | 28 |
| adapter                | 14 |
| bridge                 | 10 |
| bridges                | 10 |
| transports             | 10 |
| managed-mode           |  8 |
| integration            |  7 |
| persistence            |  5 |

`persistence.test.js` requires `better-sqlite3` to be compiled; it skips gracefully otherwise.

`persistence.test.js` is skipped automatically if `better-sqlite3` fails to build on the host.

---

## What is not in this package

So you do not have to go looking:

- No multi-body orchestrator. See [`@srk0102/plexa`](https://www.npmjs.com/package/@srk0102/plexa) for safety gates, approval hooks, cross-session vertical memory, lateral body-to-body events, and LLM brains with cost tracking and retry.
- No Python client. SCP bodies written in Python coordinate via `HTTPTransport` and expose `/discover`, `/health`, `/state`, `/events`, `/tool`.
- No CRDT or cross-body shared state.

---

## Links

- Source: https://github.com/srk0102/SCP
- npm: https://npmjs.com/package/scp-protocol
- Orchestrator: https://npmjs.com/package/@srk0102/plexa

## License

MIT
