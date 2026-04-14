# SCP v0.1.1 -- Honest Limitations

What it is vs what it is not. Written after external review.

---

## What v0.1.1 actually is

A reactive control system with decision caching.

Three layers run in priority order:
1. Reflex: hardcoded rules, fires instantly
2. Cache: replays past LLM decisions for similar states
3. Brain: LLM fallback for unknown states

The cache reduces LLM calls over time. Cost approaches zero. Latency approaches zero. This is real and measured across 5 adapters.

## What v0.1.1 is NOT

- Not a learning system. It caches, it does not learn from outcomes.
- Not an AI agent. It does not plan, reason, or generalize.
- Not a neural network. Pattern store is a hash map with fuzzy matching.
- Not a replacement for RL. There is no reward signal.
- Not safe by default. A wrong LLM decision gets cached and replayed.

---

## Specific weaknesses

### 1. Caching is not learning

**What we say:** "Brain teaches once. Muscle remembers forever."
**What is true:** Brain decides once. Cache replays that decision blindly.
**What is missing:** No evaluation of whether the decision was good.
**What would fix it:** Outcome scoring after every action. Reinforce good decisions, suppress bad ones. Planned for v0.2.0.

### 2. Feature extraction is manual

**What we say:** Developer defines feature extractor.
**What is true:** The developer decides what features matter. If they pick wrong features, the cache is useless.
**What is missing:** No automatic feature discovery. No spatial awareness. No temporal context.
**What would fix it:** Richer state representation. Learned features from raw sensor data. Planned for v0.3.0.

### 3. No temporal memory

**What we say:** "Real-time AI execution runtime."
**What is true:** Each frame is independent. No memory of what happened 1 second ago.
**What is missing:** Trajectory awareness. Sequence decisions. Planning over time.
**What would fix it:** Sliding window of recent states as context. Planned for v0.3.0.

### 4. No safety validation

**What we say:** Reflex layer handles safety.
**What is true:** Reflex handles hardcoded rules (stop if too close). But LLM decisions go straight to cache without validation.
**What is missing:** A gate between LLM output and cache storage. Transient vs verified tiers.
**What would fix it:** L1 (transient) + L2 (verified) cache tiers. Safety check before promotion. Planned for v0.2.0.

### 5. No outcome evaluation

**What we say:** "Muscle handles 99%. Brain handles 1%."
**What is true:** The muscle replays decisions. It never checks if they worked.
**What is missing:** A reward signal. Score after every action.
**What would fix it:** Evaluate state_after vs state_before. Reinforce or suppress. Planned for v0.2.0.

### 6. Exploration is implemented but limited

**What we say:** 10% exploration rate.
**What is true:** 10% of cache hits are randomly sent to brain for verification. This catches drift.
**What is missing:** No epsilon-greedy over alternative actions. Only verifies the same decision.
**What would fix it:** True exploration: try different actions, compare outcomes. Planned for v0.3.0.

---

## What is genuinely strong

These are not oversold. They work as described.

1. **Cost reduction is real.** Brain calls drop from 27/min to 0/min. Measured across 5 adapters.
2. **Cross-body works.** Same protocol, same brain, 5 different bodies. Zero code changes.
3. **Cross-language works.** JS + Python via HTTPTransport. MuJoCo proven.
4. **Real physics works.** Cart-pole balanced 64+ loops with 89% cache rate.
5. **Three-layer priority works.** Reflex fires before cache. Cache fires before brain. Order is correct.
6. **Similarity matching works.** Fuzzy feature distance finds close-enough patterns.
7. **Exploration catches drift.** 10% verification rate detected brain drift in testing.

---

## Path from v0.1.1 to v1.0.0

```
v0.1.1 (now):   Reactive caching. Works but does not learn.
v0.2.0 (next):  Confidence gating. Safety validation. Outcome evaluation.
v0.3.0:         Small classifier. Temporal memory. Actual learning.
v0.4.0:         Live distillation. Model trains during operation.
v1.0.0:         Stable API. Learned model proven. Safety certified.
```

Each version fixes a specific weakness. No version claims to be more than it is.
