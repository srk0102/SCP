<p align="center">
  <img src="https://raw.githubusercontent.com/srk0102/SCP/master/assets/logo.svg" width="120" height="120" alt="SCP"/>
</p>

<h1 align="center">scp-protocol</h1>

<p align="center">
  Any LLM. Any body. Brain teaches once. Muscle remembers.
</p>

<p align="center">
  <a href="https://npmjs.com/package/scp-protocol"><img src="https://img.shields.io/npm/v/scp-protocol?color=4F46E5&label=npm" alt="npm"/></a>
  <a href="https://srk-e37e8aa3.mintlify.app"><img src="https://img.shields.io/badge/docs-mintlify-818CF8" alt="docs"/></a>
  <a href="https://github.com/srk0102/SCP"><img src="https://img.shields.io/badge/tests-145%20passing-10B981" alt="tests"/></a>
  <a href="https://github.com/srk0102/plexa"><img src="https://img.shields.io/badge/orchestrate_with-plexa-818CF8" alt="plexa"/></a>
</p>

---

## The problem

Every LLM-controlled body today is welded to one environment. Change the body and you rebuild everything: the prompt, the tool schema, the cache, the plumbing. There was no open protocol for it.

## The insight

Let the body run at 60Hz. Push events up only when it cannot answer locally. The brain teaches. The muscle remembers.

| Session | Brain calls | Cost (Nova Micro) |
|--------:|------------:|------------------:|
| 1       | 27          | $0.0270           |
| 2       | 4           | $0.0040           |
| 3       | 0           | $0.0000           |

Familiar situations are handled locally. Novel situations wake the brain. Cost is proportional to novelty.

## Install

```bash
npm install scp-protocol          # one body
npm install @srk0102/plexa        # many bodies under one brain
```

## Quick start (5 minutes)

```javascript
const { SCPBody, PatternStore } = require("scp-protocol")
const { OllamaBridge } = require("scp-protocol/bridges/ollama")

class Patrol extends SCPBody {
  static bodyName = "patrol"
  static tools = {
    advance: { description: "move forward", parameters: { speed: { type: "number", min: 0, max: 1, required: true } } },
    halt:    { description: "stop", parameters: {} },
  }
  async advance({ speed }) { console.log(`advancing at ${speed}`) }
  async halt()             { console.log("halted") }
}

const body = new Patrol({
  patternStore: new PatternStore({ featureExtractor: (e) => ({ kind: e.kind }) }),
})

// Same situation twice. Second time is cached.
const entity = { kind: "obstacle" }
let hit = body.decideLocally(entity)
if (!hit) {
  const bridge = new OllamaBridge({ model: "llama3.2" })
  // body.learnFromBrain(entity, "halt")   // pretend LLM said halt
  body.learnFromBrain(entity, "halt")
  await body.invokeTool("halt")
} else {
  await body.invokeTool(hit.decision)
}

// Next tick, same entity:
hit = body.decideLocally(entity)
console.log(hit)   // { decision: "halt", confidence: 0.05, source: "exact" }
```

Expected output:

```
halted
{ decision: 'halt', confidence: 0.05, source: 'exact' }
```

## When to use what

| You have | Install |
|---|---|
| One body | `npm install scp-protocol` |
| Several bodies, one brain | `npm install @srk0102/plexa` |

Plexa is built on scp-protocol. Anything an SCP body does inside Plexa works identically outside.

## Not just robotics

SCP works for any system that runs continuously and pushes events:

```
Game NPCs   Robot arms   Web servers   Log monitors   API gateways   Any loop
```

If it ticks and emits events, SCP connects it to any LLM. See [examples/web-backend](https://srk-e37e8aa3.mintlify.app/examples/web-backend) in the docs.

## Adapters tested

| Adapter | Physics | Cache rate |
|---|---|---|
| Missile Defense | Canvas 2D | ~100% |
| Self-Driving Car | Canvas 2D | ~90% |
| 10-Lane Highway | Canvas 2D | ~90% |
| MuJoCo Cart-Pole | Real 3D physics | 89% |
| MuJoCo Ant | Real 3D physics | 85% |

Five adapters, two languages (JS and Python), one protocol.

## Docs

Full documentation: **https://srk-e37e8aa3.mintlify.app**

Pages cover the three-layer architecture, the pattern store and adaptive memory, bridges, the adapter contract, the full API, and four complete walkthroughs (cart-pole, two bodies, web backend, and more).

## License

[MIT](LICENSE)
