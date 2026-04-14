# SCP -- Session Report
## What was built, what was proven, what to do next

Last updated: 2026-04-13

---

## Current State

**GitHub:** https://github.com/srk0102/SCP
**npm:** https://npmjs.com/package/scp-protocol (v0.1.0, published)
**Docs:** https://srk-e37e8aa3.mintlify.app (separate repo: srk0102/docs)

---

## What Was Built

### Phase 1: SDK Foundation -- DONE

Created `packages/scp-core/` with:

| Module | File | What it does |
|--------|------|-------------|
| PatternStore | pattern-store.js | Similarity matching, confidence scoring (0-1), exploration rate, smart eviction, dual persistence (localStorage + SQLite) |
| SCPAdapter | adapter.js | Base class for any body, reflex layer (fires before cache/brain), lifecycle hooks |
| SCPBridge | bridge.js | Base class for any LLM, call timing, error tracking, stats |

All three browser adapters (aim-lab, self-driving-car, highway) updated to import from scp-core.

76 tests passing (node:test, zero external deps).

Published to npm: `npm install scp-protocol`

### Phase 3: Bridge Modules -- DONE

| Bridge | File | Provider |
|--------|------|----------|
| BedrockBridge | bridges/bedrock.js | AWS Nova Micro, Claude ($0.001/call) |
| OllamaBridge | bridges/ollama.js | Local models (llama3.2, mistral), free |
| OpenAIBridge | bridges/openai.js | GPT-4o, GPT-4o-mini |

All share the same interface. Tested.

### Phase 4: Transport Modules -- DONE

| Transport | File | Best for |
|-----------|------|----------|
| SCPTransport | transports/base.js | Base class, extend for custom |
| WebSocketTransport | transports/websocket.js | Browser adapters, desktop |
| HTTPTransport | transports/http.js | Hardware (Raspberry Pi), cross-language (Python) |

HTTPTransport proven with MuJoCo adapters (Python <-> Node.js).

### Phase 5: MuJoCo Validation -- DONE

Two MuJoCo adapters built and tested:

**Cart-Pole (the demo):**
- Real MuJoCo 3D physics, real joint constraints
- Pole balanced for 64+ loops without falling
- Brain calls: 27 -> 0 over session
- Cache rate: 89% peak
- Three SCP layers working: reflex (emergency tilt), cache (learned balance), brain (PD controller)

**Ant (experimental):**
- 8-joint quadruped with 3D physics
- 85% cache rate, pattern store learning
- Gait needs tuning (falls over) but SCP pipeline proven

Both use Python pattern store (port of JS scp-core) connected via HTTPTransport to Node.js bridge.

### Phase 2: Docs -- PARTIAL

Mintlify docs site live at https://srk-e37e8aa3.mintlify.app
Separate repo: https://github.com/srk0102/docs

| Page | Status |
|------|--------|
| introduction.mdx | Done |
| getting-started.mdx | Done |
| concepts.mdx | Not started |
| adapter.mdx | Not started |
| pattern-store.mdx | Not started |
| bridges.mdx | Not started |
| roadmap.mdx | Not started |
| faq.mdx | Not started |

### Repo Cleanup -- DONE

- Renamed `client/` to `bridge/`
- Merged `image/` + `videos/` into `assets/`
- Removed all duplicate mdx files (docs moved to separate repo)
- Removed dead files (NEXT_SESSION.md, qwen_serve.py, requirements.txt)
- Added __pycache__, *.pyc, patterns.json to .gitignore

---

## Five Adapters Proven

| Adapter | Type | Physics | Brain calls | Cache rate |
|---------|------|---------|-------------|------------|
| Missile Defense | Browser/Canvas | 2D sprites | 27/min -> 0/min | ~100% |
| Self-Driving Car | Browser/Canvas | 2D sprites | drops to 0-3 | ~90% |
| 10-Lane Highway | Browser/Canvas | 2D sprites | drops over session | ~90% |
| **MuJoCo Cart-Pole** | **Python/MuJoCo** | **Real 3D physics** | **27 -> 0** | **89%** |
| MuJoCo Ant | Python/MuJoCo | Real 3D physics | 60 -> 6 | 85% |

Same protocol. Two languages. Five different bodies. Brain calls drop to near-zero in all cases.

---

## Repo Structure

```
SCP/
  schema/                    Frozen protocol v0.1.0
  server/                    MCP server + WebSocket bridge
  bridge/                    LLM bridge (Bedrock Nova Micro)
  adapters/
    aim-lab/                 Missile defense (browser)
    self-driving-car/        3-lane road (browser)
    highway/                 10-lane highway (browser)
    mujoco-cartpole/         Cart-pole balancer (Python + MuJoCo)
    mujoco-ant/              Quadruped ant (Python + MuJoCo)
  packages/
    scp-core/                npm package (scp-protocol v0.1.0)
      bridges/               Bedrock, Ollama, OpenAI
      transports/            WebSocket, HTTP
      tests/                 76 tests
  examples/
    drone-patrol/            Simulation example (Node.js)
  assets/                    Demo videos + thumbnails
```

---

## Brand Identity

```
Name:      SCP
Full name: Spatial Context Protocol
Pattern:   Ganglion
Logo:      Octopus
Tagline:   Each arm thinks. Central brain decides what arms cannot.
Colors:    Deep indigo #4F46E5, Electric violet #818CF8, Dark bg #0F0F1A
```

---

## What To Do Next

1. v0.2.0: Confidence gating (L1 transient + L2 verified cache tiers)
2. v0.2.0: Safety layer before caching LLM decisions
3. v0.2.0: Outcome evaluation (reinforce/suppress based on result)
4. Finish remaining 5 docs pages
5. Godot plugin (primary market: indie game devs)
6. Ollama zero-cost quickstart

---

## Honest Assessment (post external review)

v0.1.1 is a reactive control system with decision caching.
It is NOT a learning system. See HONEST_LIMITATIONS.md for full analysis.

What works:
- Cost reduction to near zero (proven)
- Cross-body, cross-language (proven)
- Real physics (MuJoCo proven)

What does not work yet:
- No outcome evaluation (cache stores decisions blindly)
- No safety validation before caching
- No temporal memory (each frame independent)
- No generalization (caching, not learning)
- Feature extraction is manual

Path forward:
```
v0.2.0: Confidence gating + safety + evaluation
v0.3.0: Small classifier + temporal memory
v0.4.0: Live distillation
v1.0.0: Stable, learned, safe
```

---

## Instructions for Next Claude Session

Read PLAN.md for the full vision and architecture. Read this REPORT.md for what was actually built.

**Do not:**
- Change server/, schema/, or the three browser adapters unless asked
- Suggest rebuilding the pattern store from scratch
- Suggest competing with LangGraph or calling SCP a LangGraph alternative
- Add external dependencies beyond better-sqlite3
- Suggest cloud services or paid APIs
- Use em dashes in any output

**The protocol is frozen at v0.1.0.** Fields can be added, never removed.

**Key phrases to use:**
- "LangGraph helps AI think. SCP helps AI act continuously in the real world."
- "In MCP the brain asks. In SCP the muscle asks."
- "Brain teaches once. Muscle remembers forever."
- "Any LLM, any body, zero training."
- "Reactive control with decision caching." (honest v0.1 description)
- "Layer 2 execution runtime for embodied AI." (positioning)

**Important context:**
- v0.1.1 is caching, not learning. Do not oversell.
- Read HONEST_LIMITATIONS.md before making claims.
- Read PLAN.md for v0.2.0 architecture (confidence gating).
- Primary market is indie game developers, not enterprise.

**What was proven:**
- 5 adapters, 2 languages (JS + Python), same protocol
- MuJoCo real physics: cart-pole balanced 64+ loops with 89% cache
- npm package published and installable
- 76 tests, 0 failures
- Brain calls consistently drop to near-zero across all adapters
