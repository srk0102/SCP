# SCP -- Spatial Context Protocol

**MCP connects a brain to information. SCP connects a brain to a body that's already moving.**

**In MCP the brain asks. In SCP the muscle asks.**

---

## Demos

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

```
Brain (LLM)       -- classifies, strategizes, decides (seconds)
Protocol (SCP)    -- messenger between brain and muscle (milliseconds)
Muscle (adapter)  -- acts, reacts, remembers (60fps, always running)
```

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

## Three adapters, same brain

| Adapter | Body | What it proves |
|---|---|---|
| **Missile Defense** | 10 launchers, 4 entity types | Brain classifies stealth + vetoes planes |
| **Self-Driving Car** | Car on 3-lane road | Ambulance yield, obstacle avoidance |
| **10-Lane Highway** | 5+5 lane divided highway | Traffic signals, chaos mode |

Same server. Same bridge. Same Nova Micro. Zero code changes between adapters.

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
