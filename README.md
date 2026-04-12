# SCP — Spatial Context Protocol

**MCP connects a brain to information. SCP connects a brain to a body that's already moving.**

**In MCP the brain asks. In SCP the muscle asks.**

---

## The Problem

Every LLM-controlled robot, character, or vehicle today is welded shut. The brain is custom-trained for one body. Swap the body, rebuild everything from scratch.

There is no open protocol that lets any LLM control any body — physical or virtual — without retraining.

SCP is that protocol.

---

## Demo: Missile Defense

https://github.com/user-attachments/assets/missle-launching-system

10 missile launchers defending a border. Heat missiles, stealth missiles, birds, passenger planes. The muscle fires on heat. The brain classifies everything else.

| Mode | Heat missiles | Stealth missiles | Friendly fire | Brain calls/min |
|---|---|---|---|---|
| No-brainer (sensors only) | Intercepted | All missed | Shoots planes | 0 |
| Brainer (LLM only) | Most missed (too slow) | Some caught | None | 60+ |
| **SCP (muscle + brain)** | **Intercepted** | **Brain classifies, muscle fires** | **Vetoed** | **15-27** |

## Demo: Self-Driving Car

https://github.com/user-attachments/assets/car-simulation

3-lane road with traffic, ambulances, and obstacles. Same brain, different body. Zero code changes to the protocol or server.

- Muscle avoids traffic (lane changes, speed control)
- Brain classifies ambulances (halt and yield) and obstacles (swerve)
- Pattern store replays brain decisions at $0 after 2 confirmations

![Highway Adapter](image/README/1775980843468.png)

---

## What SCP Adds to MCP

**1. Embodiment Handshake** — On connect, the body sends a JSON description of itself. Swap the body, swap the JSON. Zero retraining.

**2. Semantic Events (body to brain)** — The body pushes events UP without being asked. The brain wakes ONLY when the muscle can't handle something.

**3. Muscle Layer** — The body runs at 60fps. The brain's tool call drops into a system that's already moving. The muscle never stops to wait.

---

## Architecture

```
Brain (LLM)       — classifies, strategizes, decides (seconds)
Protocol (SCP)    — messenger between brain and muscle (milliseconds)
Muscle (adapter)  — acts, reacts, remembers (60fps, always running)
```

The muscle acts first. When it can't decide, it takes a safe default action and asks the brain async. The brain responds, the muscle adjusts. The pattern store replays past brain decisions so it never asks twice.

---

## The Pattern Store (Muscle Memory)

After 2 consistent brain decisions on the same pattern, the muscle replays what the brain already decided — without asking again. Zero latency. Zero cost.

The brain is not bypassed. It is cached. Same outcome, faster, cheaper, still correctable. That is exactly how biological muscle memory works.

---

## Three Adapters, Same Brain

| Adapter | Body | What it proves |
|---|---|---|
| **Missile Defense** (`adapters/aim-lab/`) | 10 launchers, 4 entity types | Brain classifies stealth + vetoes planes |
| **Self-Driving Car** (`adapters/self-driving-car/`) | Car on 3-lane road | Lane changes, ambulance yield, obstacle avoidance |
| **10-Lane Highway** (`adapters/highway/`) | 5+5 lane divided highway | Traffic signals, lane narrowing, chaos mode |

Same server. Same bridge. Same Nova Micro. **Zero code changes between adapters.**

---

## How to Run

```bash
# Terminal 1 — serve an adapter
cd adapters/self-driving-car && python -m http.server 8080

# Terminal 2 — start the bridge (spawns the MCP server internally)
cd client
PROMPT_PATH=../adapters/self-driving-car/system-prompt.md node qwen-mcp-bridge.js
```

Open `http://localhost:8080/muscle.html`. Select SCP mode. Press Play.

Swap adapters by changing the folder:

```bash
# Missile defense
cd adapters/aim-lab && python -m http.server 8080
PROMPT_PATH=../adapters/aim-lab/system-prompt.md node client/qwen-mcp-bridge.js

# Highway
cd adapters/highway && python -m http.server 8080
PROMPT_PATH=../adapters/highway/system-prompt.md node client/qwen-mcp-bridge.js
```

**Requirements:** Node.js 20+, AWS Bedrock access (Nova Micro), `.env` with AWS credentials.

Cost: ~$0.001 per brain call. Most runs cost less than $0.10.

---

## Writing an Adapter

Three files. That is the entire contract.

```
adapters/your-body/
  embodiment.json    — describe your body
  muscle.js          — physics + sensors + pattern store
  system-prompt.md   — tell the brain what to classify
```

The bridge, MCP server, and protocol require zero changes.

---

## What This Is Not

Not a competition with Tesla or Boston Dynamics. They build the best brain for one body. SCP builds the open protocol between any brain and any body.

Not a new ML technique. Not production robotics. This is a protocol proof with simulations. Hardware comes when someone writes a hardware adapter.

---

## The Pitch

Same LLM, same protocol, zero training. Adapter #1 defended a border with 10 missile launchers. Adapter #2 drove a car through traffic with ambulances and obstacles. The protocol didn't change. The brain didn't change. Just the adapter.

Any LLM that produces JSON tool calls can control any body through SCP — with zero training. The muscle handles speed. The brain handles intelligence. The muscle replays what the brain already decided — without asking again.

---

## License

MIT

## Built by

[srk0102](https://github.com/srk0102)
