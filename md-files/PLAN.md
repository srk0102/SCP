# SCP — Spatial Context Protocol
## Master Development Plan

---

## What SCP Is

SCP is a real-time execution runtime for embodied AI systems. It connects any LLM to any body — physical or virtual — without retraining.

**The one line positioning:**
"LangGraph helps AI think. SCP helps AI act continuously in the real world."

**The inversion:**
In MCP the brain asks. In SCP the muscle asks.

---

## What Exists Today (Working, Proven)

**GitHub:** https://github.com/srk0102/SCP

**Three working adapters, same brain, same protocol, zero code changes:**
- Missile defense (10 launchers, 4 entity types, 3 modes)
- Self-driving car (3-lane road, ambulances, obstacles)
- 10-lane highway (traffic signals, chaos mode)

**Proven results:**
- 125+ assign_targets calls landing reliably
- Brain calls dropped from 27/min to 0/min across sessions
- Pattern store learning and replaying brain decisions locally
- Same Nova Micro, same bridge, same protocol across all three adapters

**Current stack:**
- Amazon Nova Micro (AWS Bedrock, $0.001/call)
- Node.js bridge (client/qwen-mcp-bridge.js)
- MCP server (server/mcp-server.js)
- WebSocket bridge (server/ws-bridge.js, port 7777)
- Pattern store (adapters/aim-lab/pattern-store.js)
- Schema frozen at v0.1.0 (schema/scp-v0.json)

**Current file structure:**
```
SCP/
  adapters/
    aim-lab/          (missile defense)
    self-driving-car/ (car simulation)
    highway/          (10-lane highway)
  client/             (bridge + system prompt)
  server/             (MCP server, WS bridge, world store, loggers)
  schema/             (scp-v0.json)
  README.md
  REPORT.md
```

---

## The Architecture (Fully Designed)

### Three Layers (Biological Accuracy)

```
Reflex Layer    (0-5ms)    → hardcoded rules, never asks brain
Muscle Layer    (5-50ms)   → pattern store, replays brain decisions
Brain Layer     (500ms-3s) → LLM, handles genuinely novel situations
```

### The Full Pipeline

```
Retrieve  → pattern store finds relevant past decisions
Augment   → dynamic prompt builder adds world state + history
Generate  → LLM generates intent with full context
Execute   → muscle acts on that intent instantly
```

SCP uses RAG-like memory internally but is fundamentally a real-time execution runtime. RAG is a component. SCP is the system.

### State Architecture

```
Shared State (open)
  World model, threat level, score, time
  Visible to brain, muscle, all modules
  Any adapter can read

Private State (closed)
  Per-adapter only (cooldowns, joint angles, lane position)
  Brain never touches directly
  Surfaces through semantic events only

Module State (encapsulated)
  Per-module only
  Reflex does not see pattern store internals
```

### Memory Stack

```
Hot cache    (0.1ms)  → in-memory Map, real-time path only
Warm cache   (5ms)    → SQLite via better-sqlite3, persists across restarts
Cold storage (bg)     → vector similarity, background worker only, never blocks
```

**Critical rule:** Real-time loop never waits for anything except RAM.

### Dynamic Prompt Builder

Every brain call gets a fresh prompt built from:
```
[AUTO from embodiment.json]
Body identity, actuators, sensors, constraints, role

[DYNAMIC per call]
Current world state, body status, recent history (sliding window)

[DEVELOPER WRITES]
Classification rules, what each entity means, what actions are appropriate
```

### Prefetch System

```
Entity enters outer detection zone (far)  → ask brain immediately
Brain classifies while entity still distant
Entity enters action zone (close)         → muscle already has answer
Acts instantly, zero wait
```

---

## The SDK Vision (What To Build)

### Positioning

Not LangChain alternative. Not RAG system. Not MCP wrapper.

**"Real-time AI execution runtime for embodied systems."**

Like LangGraph gave developers graph primitives, SCP gives developers nervous system primitives.

### npm install scp-protocol

When someone installs SCP they get:
- In-memory hot cache (pure JS, zero deps)
- SQLite warm cache (better-sqlite3, bundled)
- Background worker (Node built-in)
- Zero external services
- Zero configuration
- Works immediately

### Core Modules

```
SCPAdapter       → base class for any body
PatternStore     → muscle memory cache (hot + warm + cold)
SCPBridge        → connects to any LLM
Reflex           → hardcoded instant rules
Prefetch         → ask brain before needed
PromptBuilder    → dynamic context injection
WorldModel       → maintains environment state
SharedState      → cross-adapter state
PrivateState     → per-adapter encapsulated state
AbortController  → cancel in-flight actions
```

### Transport Modules (pluggable)

```
WebSocketTransport  → browser and desktop (exists today)
MQTTTransport       → IoT and sensors
GRPCTransport       → robots and hardware
HTTPTransport       → simple REST
SerialTransport     → Arduino and Raspberry Pi
```

### Bridge Modules (pluggable)

```
BedrockBridge    → AWS Nova Micro (exists today)
OpenAIBridge     → GPT-4o, GPT-4-mini
AnthropicBridge  → Claude direct
OllamaBridge     → local models, free, zero cost
CustomBridge     → bring your own LLM
```

### Developer Experience Target

```javascript
import { SCPAdapter, Reflex, OllamaBridge, MQTTTransport } from 'scp-protocol'

const adapter = new SCPAdapter({
  embodiment: './embodiment.json',
  transport: new MQTTTransport({ broker: 'mqtt://localhost' }),
  bridge: new OllamaBridge({ model: 'llama3.2' }),
  storage: 'sqlite',
})

adapter.reflex('emergency_stop', (state) => {
  if (state.pressure > MAX) adapter.stop()
})

adapter.features((entity) => ({
  has_heat: entity.has_heat,
  direction: entity.vx > entity.vy ? 'horizontal' : 'vertical',
  speed: Math.round(entity.speed / 20) * 20,
}))

adapter.run()
```

---

## PatternStore Evolution (Critical Path)

### Stage 1 (today): Hashmap
Exact hash matching. Binary hit/miss. Works for identical situations.

### Stage 2 (next): Similarity + Confidence
Fuzzy feature matching. Confidence scoring 0-1. Works for similar situations.

### Stage 3 (later): Small Classifier
Trained on brain decisions collected in stage 1 and 2. ONNX export. Drop-in replacement. Works for genuinely new situations.

### Stage 4 (much later): Live Distillation
LLM teaches muscle model continuously during operation. No offline training. No separate pipeline. Near zero LLM calls in production.

**The key insight:** PatternStore is not just a cache. It is a data collection system for the model that eventually replaces it. Every brain decision logged is a training sample.

---

## What Makes SCP Different

### vs LangChain / LangGraph
```
LangGraph: stateless reasoning pipelines, digital environments
SCP: real-time continuous loop, physical and virtual bodies
LangGraph thinks. SCP acts.
```

### vs muscle-mem (pig-dot-dev)
```
muscle-mem: desktop automation agents, discrete tool calls, pivoted to Butter
SCP: physical bodies at 60fps, continuous state, embodiment schema
```

### vs LeRobot / GR00T
```
LeRobot/GR00T: specific hardware, requires training, closed ecosystem
SCP: any LLM, any body, zero training, open protocol
```

### vs Inworld AI / Convai
```
Inworld/Convai: proprietary, per-interaction pricing, closed
SCP: open source, MIT, cost drops to near zero after learning phase
```

---

## Real Use Cases (Honest)

### Near term (virtual, proven concept)
- Indie game NPC behavior (learn once, no API cost after)
- Animation character autonomous behavior
- Simulation and training environments

### Medium term (virtual to physical)
- Hobby robots (Raspberry Pi, Arduino)
- Educational robotics
- IoT device coordination

### Long term (when models get faster)
- Real-time robotics
- Hardware control systems
- Humanoid robot nervous system layer

---

## Humanoid Robot Vision

```
Reflex layer:   balance, hot surface retract, obstacle stop
Muscle layer:   walking gait, known object pickup, common phrases
Brain layer:    novel situations, complex conversation, strategic decisions
```

Dynamic prompt per brain call:
```
Location, speaker identity, conversation history,
body status, objects in view, recent decisions, constraints
```

The brain never touches actuators directly. Only returns intent. Muscle is the only controller.

---

## Build Order

### Phase 1: SDK Foundation -- DONE
```
1. Created packages/scp-core/
2. Moved pattern-store.js into it
3. Added similarity matching (fuzzy feature distance)
4. Added confidence scoring (0-1 float per pattern)
5. Added exploration rate (verify cache hit with brain 10% of time)
6. Added SQLite persistence via better-sqlite3
7. Wrote package.json (scp-protocol v0.1.0)
8. 56 tests passing, 0 failing
9. All three adapters import from scp-core
```

### Phase 2: Docs -- IN PROGRESS
```
1. Mintlify docs site connected to repo
2. introduction.mdx -- DONE
3. getting-started.mdx -- DONE
4. concepts.mdx
5. adapter.mdx
6. pattern-store.mdx
7. bridges.mdx
8. roadmap.mdx
9. faq.mdx
```

### Phase 3: Bridge Modules
```
1. Extract BedrockBridge from qwen-mcp-bridge.js
2. Build OllamaBridge (free local models)
3. Build OpenAIBridge
4. Pluggable interface: any bridge works
```

### Phase 4: Transport Modules
```
1. Extract WebSocketTransport from ws-bridge.js
2. Build HTTPTransport (simplest for new adapters)
3. Build MQTTTransport (IoT)
```

### Phase 5: HTTP Server (LangChain-style cross-language support)
```
SCP Core HTTP Server runs locally on port 3000.
Any language talks to it via REST.

Endpoints:
  POST /adapter/register     register embodiment
  POST /event/emit           muscle emits event
  GET  /brain/response       poll brain decision
  POST /pattern/learn        teach pattern store
  GET  /pattern/lookup       check pattern store
  GET  /stats                session stats

This is how Python, Go, Rust wrappers work.
They wrap HTTP calls to this server. Thin layer.
```

### Phase 6: Python SDK
```
pip install scp-protocol
Wraps the HTTP server from Phase 5.
Same API, different language.
```

### Phase 7: Game Engine Adapters
```
1. Godot plugin
2. Unity package
3. Lottie adapter (connects AnimTOON-3B characters)
```

### Phase 8: Community Growth
```
1. Community files issues, requests features
2. Someone writes Go wrapper
3. Someone writes Rust wrapper
4. Self-sustaining ecosystem
```

---

## Timeline (Honest)

```
Now:        npm publish scp-protocol v0.1.0
Week 2:     Docs live on Mintlify
Week 3:     Bridge modules (Ollama, OpenAI)
Week 4:     SCP HTTP server built
Month 2:    pip install scp-protocol (Python wrapper)
Month 3:    Community files issues, first external adapter
Month 6:    Self-sustaining ecosystem
```

---

## Known Honest Limitations (Do Not Hide These)

1. Bird/stealth misclassification bug (speed bucketing too coarse)
2. Friendly fire timing (mark_ignore arrives after muscle fires)
3. One real LLM provider today (Bedrock Nova Micro)
4. No retry logic in bridge
5. No cost tracking per session
6. No brain call timing in logs

---

## Connected Projects

**AnimTOON-3B:** https://huggingface.co/srk0102/AnimTOON-3B
Open model that rigs SVG characters into Lottie animations.
AnimTOON generates the character. SCP drives how it behaves.

**The origin story:**
Building AnimTOON-3B hit a wall trying to extend to 3D rigging.
Model trying to understand AND control a body simultaneously.
No model is good at both. That realization led to SCP.

---

## Key Phrases (Use These Exactly)

- "LangGraph helps AI think. SCP helps AI act continuously in the real world."
- "In MCP the brain asks. In SCP the muscle asks."
- "Brain teaches once. Muscle remembers forever."
- "Any LLM, any body, zero training."
- "Muscle handles 99%. Brain handles 1%."
- "RAG is a component. SCP is the system."
- "Real-time AI execution runtime for embodied systems."

---

## What Not To Build (Scope Control)

- Graph execution engine (LangGraph's problem, not SCP's)
- Cloud hosted service (open source first)
- Specific hardware drivers (community writes adapters)
- End-to-end vision models (muscle layer component, not core)
- Paid features (MIT forever)
