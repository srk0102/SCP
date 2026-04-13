<p align="center">
  <img src="assets/logo.svg" width="80" height="80" alt="SCP Logo"/>
</p>

<h1 align="center">SCP -- Spatial Context Protocol</h1>

<p align="center">
  <strong>MCP connects a brain to information. SCP connects a brain to a body that's already moving.</strong>
  <br/>
  <em>In MCP the brain asks. In SCP the muscle asks.</em>
</p>

<p align="center">
  <a href="https://npmjs.com/package/scp-protocol"><img src="https://img.shields.io/npm/v/scp-protocol?color=4F46E5&label=npm" alt="npm"/></a>
  <a href="https://github.com/srk0102/SCP"><img src="https://img.shields.io/github/license/srk0102/SCP?color=818CF8" alt="license"/></a>
  <a href="https://srk-e37e8aa3.mintlify.app"><img src="https://img.shields.io/badge/docs-mintlify-818CF8" alt="docs"/></a>
</p>

---

## MuJoCo Cart-Pole: Real Physics, Brain Learns to Zero

[![Watch the demo](https://res.cloudinary.com/still-studying/video/upload/so_3/Screen_Recording_2026-04-13_010202_qlnftl.jpg)](https://res.cloudinary.com/still-studying/video/upload/Screen_Recording_2026-04-13_010202_qlnftl.mp4)

*Click to watch* -- Real MuJoCo physics. Real joint constraints. The brain starts at 31 calls/loop. By loop 24, it drops to 1. The pole stays balanced. The muscle learned.

```
Loop  1: brain=31  cache=119  reflex=43   <- brain handles most decisions
Loop  5: brain= 5  cache=153  reflex=35   <- cache taking over
Loop 12: brain= 4  cache=148  reflex=40   <- muscle learned
Loop 24: brain= 1  cache=158  reflex=35   <- brain nearly silent
```

Three layers visible: **reflex** catches emergency tilts, **cache** replays learned balance, **brain** only fires for new situations.

---

## More Demos

<table>
<tr>
<td width="50%" align="center">

### Missile Defense

[![Missile Defense Demo](assets/missile-defense-thumb.png)](assets/missile-defense.mp4)

*Click to watch video* | 10 launchers defending a border. Muscle fires on heat. Brain classifies stealth missiles and vetoes planes.

</td>
<td width="50%" align="center">

### Self-Driving Car

[![Self-Driving Car Demo](assets/car-simulation-thumb.png)](assets/car-simulation.mp4)

*Click to watch video* | 3-lane road with traffic, ambulances, obstacles. Same brain, different body. Zero protocol changes.

</td>
</tr>
</table>

---

## What SCP adds to MCP

| | MCP | SCP |
|---|---|---|
| **Who initiates** | Brain asks, tool answers | Body acts, brain advises |
| **Body behavior** | Passive (waits for brain) | Active (runs at 60fps) |
| **Events** | Pull only | Body pushes events up |
| **Memory** | None | Pattern store replays past brain decisions |
| **Latency** | Every action waits for LLM | Muscle handles 99%, brain handles 1% |

---

## Architecture

![SCP Architecture](assets/architecture.svg)

---

## SDK

```bash
npm install scp-protocol
```

The SDK (`packages/scp-core/`) exports:

| Module | What it does |
|--------|-------------|
| **PatternStore** | Muscle memory with similarity matching, confidence scoring, exploration rate |
| **SCPAdapter** | Base class for any body, with reflex layer |
| **SCPBridge** | Base class for any LLM provider |
| **BedrockBridge** | AWS Nova Micro, Claude via Bedrock |
| **OllamaBridge** | Local models (llama3.2, mistral), free |
| **OpenAIBridge** | GPT-4o, GPT-4o-mini |
| **WebSocketTransport** | Browser and desktop adapters |
| **HTTPTransport** | Hardware adapters (Raspberry Pi, ESP32) |

76 tests. Zero external services. SQLite ships bundled.

---

## How to run

```bash
# Terminal 1 -- serve an adapter
cd adapters/self-driving-car && python -m http.server 8080

# Terminal 2 -- start the bridge (spawns MCP server internally)
cd bridge
PROMPT_PATH=../adapters/self-driving-car/system-prompt.md node qwen-mcp-bridge.js
```

Open `http://localhost:8080/muscle.html`. Select SCP mode. Press Play.

**Requirements:** Node.js 18+, AWS Bedrock access (Nova Micro), `.env` with AWS credentials.

---

## Repo structure

```
SCP/
  schema/             Frozen protocol (v0.1.0)
  server/             MCP server + WebSocket bridge
  bridge/             LLM bridge (Bedrock Nova Micro)
  adapters/
    aim-lab/          Missile defense (10 launchers)
    self-driving-car/ 3-lane road
    highway/          10-lane divided highway
  packages/
    scp-core/         npm package (scp-protocol)
      bridges/        Bedrock, Ollama, OpenAI
      transports/     WebSocket, HTTP
      tests/          76 tests
  examples/
    drone-patrol/     Simulation example
  assets/             Demo videos and thumbnails
  PLAN.md             Master development plan
```

---

## Five adapters, same brain

![Adapter Proof](assets/adapters-proof.svg)

Same server. Same bridge. Same protocol. Two languages. Zero code changes between adapters.

---

## Writing an adapter

Three files. That is the entire contract.

```
adapters/your-body/
  embodiment.json    -- describe your body
  muscle.js          -- physics + sensors + pattern store
  system-prompt.md   -- tell the brain what to classify
```

The bridge, MCP server, and protocol require zero changes.

---

## Links

- **Docs:** https://srk-e37e8aa3.mintlify.app
- **npm:** https://npmjs.com/package/scp-protocol
- **AnimTOON-3B:** https://huggingface.co/srk0102/AnimTOON-3B

---

## License

MIT

## Built by

[srk0102](https://github.com/srk0102)
