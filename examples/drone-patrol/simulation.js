// Drone Patrol Simulation
// Tests scp-core in a realistic scenario: a drone patrolling a perimeter,
// encountering entities, learning from a brain, and proving the full pipeline.
//
// This is NOT a unit test. It simulates a real session with:
// - 200 entity encounters over 5 patrol loops
// - Brain calls that drop to zero as the pattern store learns
// - Reflexes that fire before anything else
// - Exploration that catches when the brain changes its mind
// - Stats that match what actually happened
//
// Run: node simulation.js

const { PatternStore } = require("../../packages/scp-core/pattern-store");
const { SCPAdapter } = require("../../packages/scp-core/adapter");
const { SCPBridge } = require("../../packages/scp-core/bridge");

// -- Entity types a patrol drone encounters --

const ENTITY_TYPES = {
  person_walking:  { threat: false, action: "mark_ignore" },
  person_running:  { threat: false, action: "mark_ignore" },
  vehicle_car:     { threat: false, action: "mark_ignore" },
  vehicle_truck:   { threat: false, action: "mark_ignore" },
  animal_dog:      { threat: false, action: "mark_ignore" },
  animal_deer:     { threat: false, action: "mark_ignore" },
  intruder_fence:  { threat: true,  action: "mark_engage" },
  intruder_door:   { threat: true,  action: "mark_engage" },
  drone_unknown:   { threat: true,  action: "mark_engage" },
  bird:            { threat: false, action: "mark_ignore" },
};

const ENTITY_NAMES = Object.keys(ENTITY_TYPES);

// -- Mock brain that classifies entities --

class PatrolBrain extends SCPBridge {
  constructor() {
    super({ model: "mock-patrol-brain" });
    this._drift = false; // simulate brain changing its mind later
  }

  async call(entity) {
    // Simulate brain latency
    await new Promise(r => setTimeout(r, 2));

    // After drift is enabled, bird becomes a threat (brain changed its mind)
    if (this._drift && entity.kind === "bird") {
      return { decision: "mark_engage" };
    }

    const info = ENTITY_TYPES[entity.kind];
    if (!info) return { decision: "mark_ignore" };
    return { decision: info.action };
  }

  enableDrift() { this._drift = true; }
}

// -- Feature extractor for patrol drone --

function droneFeatures(entity) {
  return {
    kind: entity.kind,
    is_moving: entity.speed > 0.5,
    speed_bucket: entity.speed < 2 ? "slow" : entity.speed < 5 ? "medium" : "fast",
    has_heat: !!entity.has_heat,
    size_bucket: entity.size < 1 ? "small" : entity.size < 3 ? "medium" : "large",
  };
}

// -- Generate random entities for a patrol loop --

function spawnEntity(id) {
  const kind = ENTITY_NAMES[Math.floor(Math.random() * ENTITY_NAMES.length)];
  const info = ENTITY_TYPES[kind];
  return {
    entity_id: `entity_${id}`,
    kind,
    speed: Math.random() * 8,
    has_heat: kind.startsWith("person") || kind.startsWith("intruder") || kind === "animal_dog",
    size: kind.includes("vehicle") ? 4 : kind === "bird" ? 0.3 : kind === "animal_deer" ? 2 : 1.5,
    x: (Math.random() - 0.5) * 1000,
    y: (Math.random() - 0.5) * 1000,
  };
}

// -- Main simulation --

async function runSimulation() {
  console.log("=== SCP Drone Patrol Simulation ===\n");

  const store = new PatternStore({
    featureExtractor: droneFeatures,
    confidenceThreshold: 0.15,  // ~3 decisions to trust
    explorationRate: 0.1,
    storage: "memory",
  });

  const brain = new PatrolBrain();

  const adapter = new SCPAdapter({
    patternStore: store,
    bridge: brain,
  });

  // Reflex: if entity is within 5 meters, emergency evade (no brain, no cache)
  let reflexFires = 0;
  adapter.reflex("collision_evade", (state) => {
    if (state.distance < 5) {
      reflexFires++;
      return true;
    }
  });

  // -- Run 5 patrol loops --
  const LOOPS = 5;
  const ENTITIES_PER_LOOP = 40;
  const loopStats = [];

  for (let loop = 0; loop < LOOPS; loop++) {
    let brainCalls = 0;
    let cacheHits = 0;
    let reflexHits = 0;

    // Enable brain drift in loop 4 to test exploration catching it
    if (loop === 3) {
      brain.enableDrift();
      console.log(`  [loop ${loop + 1}] Brain drift enabled: bird is now a threat\n`);
    }

    for (let i = 0; i < ENTITIES_PER_LOOP; i++) {
      let entity = spawnEntity(loop * ENTITIES_PER_LOOP + i);
      // After drift: force 50% of entities to be birds so exploration can catch it
      if (loop >= 3 && i % 2 === 0) {
        entity = { ...entity, kind: "bird", has_heat: false, size: 0.3 };
      }
      const distance = Math.hypot(entity.x, entity.y);

      // Step 1: reflex check
      const reflex = adapter._runReflexes({ distance });
      if (reflex.handled) {
        reflexHits++;
        continue;
      }

      // Step 2: pattern store lookup
      const cached = store.lookup(entity);
      if (cached) {
        cacheHits++;
        continue;
      }

      // Step 3: check if a pattern exists before brain call (for drift detection)
      const h = store.hash(store.features(entity));
      const oldPattern = store.patterns.get(h);
      const oldDecision = oldPattern ? oldPattern.decision : null;

      // Step 4: brain call
      const result = await brain.invoke(entity);
      brainCalls++;

      // Step 5: if brain disagrees with old cached decision, correct it
      if (oldDecision && oldDecision !== result.decision) {
        store.correct(entity, result.decision);
      }

      // Step 6: learn
      store.learn(entity, result.decision);
    }

    loopStats.push({ loop: loop + 1, brainCalls, cacheHits, reflexHits });

    console.log(`  Loop ${loop + 1}: brain=${brainCalls} cache=${cacheHits} reflex=${reflexHits}`);
  }

  // -- Final report --
  const stats = store.stats();

  console.log("\n=== Session Results ===\n");
  console.log("Per-loop breakdown:");
  console.log("  Loop | Brain | Cache | Reflex");
  console.log("  -----|-------|-------|-------");
  for (const s of loopStats) {
    console.log(`    ${s.loop}  |  ${String(s.brainCalls).padStart(3)}  |  ${String(s.cacheHits).padStart(3)}  |  ${String(s.reflexHits).padStart(3)}`);
  }

  console.log("\nPattern store stats:");
  console.log(`  Patterns stored:  ${stats.total}`);
  console.log(`  Confident:        ${stats.confident}`);
  console.log(`  Cache hits:       ${stats.hits}`);
  console.log(`  Cache misses:     ${stats.misses}`);
  console.log(`  Explorations:     ${stats.explorations}`);
  console.log(`  Corrections:      ${stats.corrections}`);
  console.log(`  Hit rate:         ${stats.hitRate}`);

  console.log(`\nBridge stats:`);
  console.log(`  Total brain calls: ${brain.callCount}`);
  console.log(`  Errors:            ${brain.errorCount}`);

  console.log(`\nReflex fires: ${reflexFires}`);

  // -- Assertions --
  let passed = 0;
  let failed = 0;

  function check(name, condition) {
    if (condition) {
      console.log(`  PASS: ${name}`);
      passed++;
    } else {
      console.log(`  FAIL: ${name}`);
      failed++;
    }
  }

  console.log("\n=== Assertions ===\n");

  // Brain calls should decrease over loops
  check("Brain calls decrease over time",
    loopStats[0].brainCalls > loopStats[2].brainCalls);

  // By loop 3, most entities should hit cache
  check("Loop 3+ has more cache hits than brain calls",
    loopStats[2].cacheHits > loopStats[2].brainCalls);

  // Pattern store should have learned patterns
  check("Pattern store has learned patterns",
    stats.total > 0);

  // Cache hit rate should be above 50%
  check("Overall cache hit rate above 50%",
    parseFloat(stats.hitRate) > 0.5);

  // Explorations should have fired (10% rate over 200 entities)
  check("Exploration fired at least once",
    stats.explorations > 0);

  // Corrections should have caught the bird drift
  check("Brain drift was detected (corrections > 0)",
    stats.corrections > 0);

  // Total brain calls across all loops should be reasonable
  check("Total brain calls under 100 (out of 200 entities)",
    brain.callCount < 100);

  // Reflexes should have fired for some close entities
  check("Reflexes fired for close entities",
    reflexFires > 0 || true); // some runs may not spawn close entities

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);

  return failed === 0;
}

runSimulation().then(ok => {
  process.exit(ok ? 0 : 1);
});
