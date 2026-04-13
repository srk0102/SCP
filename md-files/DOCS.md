# SCP Documentation

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Core Concepts](#core-concepts)
3. [Writing an Adapter](#writing-an-adapter)
4. [API Reference](#api-reference)
5. [Bridges (LLM Providers)](#bridges)
6. [Transports](#transports)
7. [Pattern Store (Muscle Memory)](#pattern-store)
8. [Hardware Adapters](#hardware-adapters)
9. [Roadmap](#roadmap)

---

## Getting Started

### Install

```bash
npm install scp-protocol
```

Zero external services. Zero configuration. SQLite ships bundled.

### Minimum working adapter

Three files. That is the entire contract.

```
your-adapter/
  embodiment.json    -- describe your body
  muscle.js          -- physics + sensors
  system-prompt.md   -- tell the brain what to classify
```

**embodiment.json**
```json
{
  "embodiment_id": "my-first-body",
  "scp_version": "0.1.0",
  "label": "My First SCP Adapter",
  "actuators": [
    { "actuator_id": "motor", "type": "continuous", "range": [-1.0, 1.0] }
  ],
  "sensors": ["proximity", "temperature"],
  "constraints": {
    "max_speed": 100
  }
}
```

**muscle.js**
```javascript
import { SCPAdapter, PatternStore } from 'scp-protocol'

const store = new PatternStore({ storage: 'sqlite' })
const adapter = new SCPAdapter({ embodiment: './embodiment.json', store })

// Reflex: never asks brain, fires instantly
adapter.reflex('too_close', (state) => {
  if (state.proximity < 10) adapter.stop()
})

// Main loop at 60fps
adapter.onTick((state) => {
  const cached = store.lookup(state.nearestEntity)
  if (cached) {
    adapter.execute(cached.decision)
    return
  }
  // unknown situation, escalate to brain
  adapter.emit('unknown_entity', { entity: state.nearestEntity })
})

adapter.run()
```

**system-prompt.md**
```
You are the brain of a robot.
The muscle layer handles routine movement.
You wake only when the muscle encounters something unknown.

If you see obstacle: return mark_avoid
If you see target: return mark_engage
If you see human: return mark_stop
```

### Run it

```bash
# Terminal 1: serve your adapter
cd your-adapter && python -m http.server 8080

# Terminal 2: start the bridge
PROMPT_PATH=./system-prompt.md node bridge.js
```

Open http://localhost:8080. Press Play.

Cost: approximately $0.001 per brain call. Most sessions under $0.10.

---

## Core Concepts

### The Three Layer Model

SCP splits intelligence into three layers based on speed:

```
Reflex Layer    0-5ms     Hardcoded rules. Never asks brain.
                          Emergency stops, safety constraints.
                          Physics does not wait for reasoning.

Muscle Layer    5-50ms    Pattern store. Replays brain decisions.
                          Handles known situations locally.
                          Zero API cost after learning.

Brain Layer     500ms-3s  LLM. Novel situations only.
                          Classifies what muscle cannot handle.
                          Gets called less over time.
```

### The Inversion

```
MCP: Brain asks → Tool answers
SCP: Muscle acts → Muscle asks brain when stuck
```

The body is always running. The brain is on call.

### The Learning Loop

```
Brain makes decision
Pattern store logs it
Next time same situation appears
Pattern store handles locally
No brain call
No cost
No latency
```

After 3 consistent brain decisions on a pattern, the muscle handles it forever.

Brain teaches once. Muscle remembers forever.

### The Cost Graph

This is what happens to API costs over time with SCP:

```
Session 1:  125 brain calls  $0.125
Session 2:   40 brain calls  $0.040
Session 3:    8 brain calls  $0.008
Session 4+:   0 brain calls  $0.000
```

The muscle learned. The brain is barely called. Cost approaches zero.

---

## Writing an Adapter

### The Three Files

**embodiment.json** describes your body to the brain.

```json
{
  "embodiment_id": "unique-id",
  "scp_version": "0.1.0",
  "label": "Human readable name",
  "actuators": [
    {
      "actuator_id": "actuator_name",
      "type": "continuous",
      "range": [-1.0, 1.0]
    },
    {
      "actuator_id": "gripper",
      "type": "binary",
      "states": ["open", "closed"]
    }
  ],
  "sensors": ["camera", "proximity", "temperature"],
  "constraints": {
    "max_speed": 100,
    "max_force": 50,
    "workspace_bounds": { "x": [-500, 500], "y": [-500, 500] }
  }
}
```

**muscle.js** contains your physics and sensor logic.

```javascript
import { SCPAdapter, PatternStore } from 'scp-protocol'

const store = new PatternStore({
  storage: 'sqlite',          // persists across sessions
  confidenceThreshold: 0.6,   // trust cache after 3 decisions
  exploreRate: 0.1,           // verify cache 10% of time
})

const adapter = new SCPAdapter({
  embodiment: './embodiment.json',
  store,
  frequency: 60,              // fps, match your hardware
})

// Define what features matter for pattern matching
adapter.features((entity) => ({
  has_heat:  entity.has_heat,
  direction: entity.vx > entity.vy ? 'horizontal' : 'vertical',
  speed:     Math.round(Math.hypot(entity.vx, entity.vy) / 20) * 20,
  distance:  Math.round(entity.distance / 50) * 50,
}))

// Add reflexes (never ask brain)
adapter.reflex('emergency_stop', (state) => {
  if (state.proximity < 5) {
    adapter.stop()
    return true // reflex fired, skip rest of tick
  }
})

adapter.reflex('low_battery', (state) => {
  if (state.battery < 10) {
    adapter.stop()
    adapter.alert('battery_critical')
    return true
  }
  if (state.battery < 20) {
    adapter.emit('low_battery_warning', { battery: state.battery })
    // continue, brain will decide
  }
})

// Main tick
adapter.onTick((state) => {
  for (const entity of state.entities) {
    const cached = store.lookup(entity)
    if (cached) {
      handleLocally(cached.decision, entity)
      continue
    }
    // unknown, escalate
    adapter.emit('entity_unclassified', {
      entity_id: entity.id,
      features: adapter.extractFeatures(entity),
    })
  }
})

// Handle brain response
adapter.onBrainResponse((intent) => {
  const entity = findEntity(intent.target_entity_id)
  if (entity) {
    store.learn(entity, intent.type)
    handleLocally(intent.type, entity)
  }
})

adapter.run()
```

**system-prompt.md** tells the brain what to classify.

```markdown
You are the strategic brain of [your system name].

The muscle layer runs at 60fps and handles all routine situations.
You wake only when the muscle encounters something it cannot classify.

## Entity Types

[list your entity types and what they mean]

## Actions Available

- mark_engage: target this entity
- mark_ignore: ignore this entity
- mark_avoid: route around this entity
- mark_stop: stop all activity

## Rules

[your classification rules here]

## Example

If you see [description]: return mark_engage
If you see [description]: return mark_ignore
```

### The Rules

1. Never touch `server/`, `client/`, or `schema/`
2. The protocol is frozen. Your adapter is the only thing you write.
3. Reflexes fire before pattern store. Pattern store fires before brain.
4. Brain never controls actuators directly. Only returns intent.
5. Muscle is the only thing that actually moves anything.

---

## API Reference

### PatternStore

```javascript
import { PatternStore } from 'scp-protocol'

const store = new PatternStore({
  storage: 'memory' | 'sqlite' | 'localStorage',
  dbPath: './scp-memory.db',        // sqlite only
  maxPatterns: 500,                  // evicts lowest confidence when exceeded
  confidenceThreshold: 0.6,          // 0-1, default 0.6 (3 consistent decisions)
  exploreRate: 0.1,                  // 0-1, % of cache hits that verify with brain
  similarityThreshold: 0.8,          // 0-1, minimum similarity for fuzzy match
})
```

**store.learn(entity, decision)**

Record a brain decision for an entity.

```javascript
store.learn(entity, 'mark_ignore')
// Call this after every brain response
// Builds confidence over time
// 3 consistent decisions → pattern trusted
```

**store.lookup(entity)**

Check if pattern store can handle this entity locally.

```javascript
const result = store.lookup(entity)
// Returns null if uncertain (escalate to brain)
// Returns { decision, confidence, source } if confident
// source: 'exact' | 'similarity'
```

**store.correct(entity, brain_decision)**

Called when brain contradicts a cached decision.

```javascript
store.correct(entity, 'mark_engage')
// Resets confidence on that pattern
// System starts re-learning correct behavior
```

**store.stats()**

```javascript
const stats = store.stats()
// Returns:
// {
//   total: 42,          // total patterns stored
//   confident: 38,      // patterns above confidence threshold
//   hits: 1247,         // times cache hit
//   misses: 89,         // times cache missed (escalated to brain)
//   explorations: 134,  // times cache verified with brain
//   corrections: 3,     // times brain corrected cache
// }
```

**store.save() / store.load()**

```javascript
store.save()  // persist to SQLite or localStorage
store.load()  // load from SQLite or localStorage on boot
```

---

### SCPAdapter

```javascript
import { SCPAdapter } from 'scp-protocol'

const adapter = new SCPAdapter({
  embodiment: './embodiment.json',   // path to embodiment JSON
  store: patternStore,               // PatternStore instance
  frequency: 60,                     // tick rate in fps
  transport: websocketTransport,     // optional, defaults to WebSocket
})
```

**adapter.reflex(name, handler)**

Register a hardcoded rule that fires before pattern store and brain.

```javascript
adapter.reflex('emergency_stop', (state) => {
  if (state.proximity < 5) {
    adapter.stop()
    return true // returning true skips rest of tick
  }
})
```

**adapter.features(extractor)**

Define what features matter for pattern matching.

```javascript
adapter.features((entity) => ({
  has_heat: entity.has_heat,
  direction: entity.vx > entity.vy ? 'horizontal' : 'vertical',
  speed: Math.round(entity.speed / 20) * 20,
}))
```

**adapter.onTick(handler)**

Main loop called at adapter.frequency fps.

```javascript
adapter.onTick((state) => {
  // your physics and sensor logic here
  // state contains current world snapshot
})
```

**adapter.emit(eventType, data)**

Push a semantic event up to the brain.

```javascript
adapter.emit('entity_unclassified', {
  entity_id: 'missile_42',
  features: { speed: 80, direction: 'vertical' },
})
```

**adapter.run() / adapter.stop()**

```javascript
adapter.run()   // start the tick loop
adapter.stop()  // stop all actuators and tick loop
```

---

### SCPBridge

Base class. Extend to add your LLM provider.

```javascript
import { SCPBridge } from 'scp-protocol'

class MyBridge extends SCPBridge {
  async callBrain(worldState, systemPrompt) {
    // call your LLM here
    // return structured intent
    return {
      intents: [
        { type: 'mark_engage', target_entity_id: 'missile_42' }
      ]
    }
  }
}
```

Built-in bridges (import separately):

```javascript
import { BedrockBridge } from 'scp-protocol/bridges/bedrock'
import { OpenAIBridge }  from 'scp-protocol/bridges/openai'
import { OllamaBridge }  from 'scp-protocol/bridges/ollama'
```

---

## Bridges

### AWS Bedrock (Nova Micro)

Current default. Cheapest cloud option.

```javascript
import { BedrockBridge } from 'scp-protocol/bridges/bedrock'

const bridge = new BedrockBridge({
  model: 'amazon.nova-micro-v1:0',
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
})
```

Cost: $0.001 per brain call.

### Ollama (Local, Free)

Best for development. Zero API cost. Runs on your machine.

```javascript
import { OllamaBridge } from 'scp-protocol/bridges/ollama'

const bridge = new OllamaBridge({
  model: 'llama3.2',         // or qwen2.5, mistral, phi3
  host: 'http://localhost:11434',
})
```

Cost: $0.00. Requires Ollama installed locally.

### OpenAI

```javascript
import { OpenAIBridge } from 'scp-protocol/bridges/openai'

const bridge = new OpenAIBridge({
  model: 'gpt-4o-mini',
  apiKey: process.env.OPENAI_API_KEY,
})
```

### Anthropic

```javascript
import { AnthropicBridge } from 'scp-protocol/bridges/anthropic'

const bridge = new AnthropicBridge({
  model: 'claude-haiku-4-5',
  apiKey: process.env.ANTHROPIC_API_KEY,
})
```

### Custom Bridge

Bring your own LLM. Implement one method.

```javascript
import { SCPBridge } from 'scp-protocol'

class CustomBridge extends SCPBridge {
  async callBrain(worldState, systemPrompt) {
    const response = await yourLLM.call({
      system: systemPrompt,
      user: JSON.stringify(worldState),
    })
    return this.parseResponse(response)
  }
}
```

---

## Transports

How the muscle layer communicates with the bridge.

### WebSocket (default)

```javascript
import { WebSocketTransport } from 'scp-protocol/transports/websocket'

const transport = new WebSocketTransport({ port: 7777 })
```

Best for: browser adapters, desktop simulations.

### HTTP

```javascript
import { HTTPTransport } from 'scp-protocol/transports/http'

const transport = new HTTPTransport({ port: 3000 })
```

Best for: simple hardware adapters, Raspberry Pi.

### MQTT

```javascript
import { MQTTTransport } from 'scp-protocol/transports/mqtt'

const transport = new MQTTTransport({
  broker: 'mqtt://localhost',
  topic: 'scp/my-robot',
})
```

Best for: IoT devices, sensor networks, low-power hardware.

### Serial

```javascript
import { SerialTransport } from 'scp-protocol/transports/serial'

const transport = new SerialTransport({
  port: '/dev/ttyUSB0',
  baudRate: 9600,
})
```

Best for: Arduino, microcontrollers.

---

## Pattern Store (Muscle Memory)

The pattern store is the most important component in SCP. It is what makes the system get cheaper and faster over time.

### How it works

```
Brain makes decision
  ↓
store.learn(entity, decision) called
  ↓
Pattern stored with confidence = 1

Same situation appears again
  ↓
store.lookup(entity) called
  ↓
Confidence below threshold → return null → escalate to brain
Brain agrees → store.learn() → confidence increases

After 3 consistent decisions:
  ↓
Confidence above threshold
  ↓
store.lookup() returns decision
  ↓
No brain call needed
Zero latency. Zero cost.
```

### Similarity Matching

The pattern store does not require an exact situation match. It uses feature similarity.

```
Stealth missile at speed 80 → brain says mark_engage → stored
Stealth missile at speed 82 → similar enough → cache hit → mark_engage
Stealth missile at speed 83 → similar enough → cache hit → mark_engage

Passenger plane at speed 80 → very different features → cache miss → brain called
```

Similarity threshold is configurable (default 0.8).

### Exploration Rate

10% of the time, even confident cache hits are sent to the brain for verification. This prevents the cache from becoming stale when the environment changes.

```javascript
const store = new PatternStore({
  exploreRate: 0.1,  // 10% verification rate
})
```

When brain contradicts a cached decision, `correct()` resets confidence and the system re-learns.

### Evolution Path

```
v0.1 (today):    Hash matching + similarity
v0.2 (planned):  Small classifier trained on stored decisions
v0.3 (planned):  Live distillation during operation
                 Near zero LLM calls in production
```

---

## Hardware Adapters

### Raspberry Pi

Requirements: Node.js 20+, Python 3, any LLM API key or Ollama installed locally.

```bash
npm install scp-protocol
npm install scp-protocol/transports/http  # simpler than WebSocket for Pi
```

Use Ollama for zero API cost:

```bash
# on the Pi
ollama pull llama3.2
```

Then write your three files. The Pi muscle.js reads GPIO sensors and controls GPIO actuators. The rest is identical to any other adapter.

### Arduino

Arduino cannot run Node.js directly. Use Serial transport.

```
Arduino (C++) → Serial → Raspberry Pi (Node.js) → SCP bridge → LLM
```

Arduino sends sensor readings over serial. Pi reads them, runs SCP, sends commands back over serial. Arduino executes commands.

### ESP32 / MicroPython

Use HTTP transport. ESP32 makes HTTP POST requests to the SCP bridge running on a Pi or laptop.

---

## Roadmap

### v0.1.0 (current)
- PatternStore with similarity matching and confidence scoring
- SCPAdapter base class with reflex layer
- SCPBridge base class
- SQLite persistence bundled
- Three working adapters (missile defense, car, highway)

### v0.2.0 (next)
- OllamaBridge (free local models)
- OpenAIBridge
- AnthropicBridge
- HTTPTransport (hardware adapters)
- MQTTTransport (IoT)
- SerialTransport (Arduino)
- Retry logic in all bridges
- Cost tracking per session
- Brain call timing in logs

### v0.3.0
- Godot plugin
- Unity package
- Raspberry Pi example adapter
- Visual debugger (browser UI showing brain calls, cache hits, costs)
- Python SDK (pip install scp-protocol)

### v0.4.0
- Small classifier replacing pattern store hashmap
- ONNX export for trained muscle models
- Benchmark suite (standard tasks any adapter can test against)
- Body registry (discover community adapters)

### v1.0.0
- Stable API
- Production ready
- Hardware certified adapters
- Enterprise support

---

## Contributing

Want to add an adapter?

1. Copy `adapters/self-driving-car/` as a template
2. Update `embodiment.json` for your body
3. Write `muscle.js` for your physics
4. Update `system-prompt.md` for your context
5. Open a PR

Want to add a bridge?

1. Extend `SCPBridge` from `scp-protocol`
2. Implement `callBrain(worldState, systemPrompt)`
3. Add to `packages/scp-core/bridges/`
4. Open a PR

Want to add a transport?

1. Extend `SCPTransport` from `scp-protocol`
2. Implement `emit(event)` and `onReceive(callback)`
3. Add to `packages/scp-core/transports/`
4. Open a PR

The only rule: do not touch `schema/`. The protocol is frozen at v0.1.0.

---

## License

MIT. Free forever.

---

## Built by

[srk0102](https://github.com/srk0102) and [AnimTOON-3B](https://huggingface.co/srk0102/AnimTOON-3B)

AnimTOON generates the character. SCP drives how it behaves.

---

## Links

- GitHub: https://github.com/srk0102/SCP
- npm: https://www.npmjs.com/package/scp-protocol
- Medium: [I Was Building an Animation Model. I Accidentally Built a Protocol.]
- AnimTOON-3B: https://huggingface.co/srk0102/AnimTOON-3B
