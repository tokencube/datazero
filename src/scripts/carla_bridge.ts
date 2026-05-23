#!/usr/bin/env npx tsx
// carla_bridge.ts — CARLA 0.9.16 simulation bridge → Zero Worker strand events.
//
// Launches CARLA scenarios via Docker on JARVIS, collects metrics, emits
// verify.scenario.* strand events through Zero Worker flywheel API.
//
// Usage:
//   npx tsx src/scripts/carla_bridge.ts --scenario lawn_nav_001
//   npx tsx src/scripts/carla_bridge.ts --scenario lawn_nav_001 --map Mine01 --headless
//   npx tsx src/scripts/carla_bridge.ts --status        (check if CARLA is running)
//   npx tsx src/scripts/carla_bridge.ts --stop           (stop CARLA container)
//
// Environment:
//   JARVIS_HOST       — SSH host for JARVIS (default: jarvis-cf)
//   ZERO_WORKER_URL   — Zero Worker base URL
//   ZERO_API_KEY      — zb_ API key for flywheel endpoints
//   CARLA_IMAGE       — Docker image (default: carlasim/carla:0.9.16)

import { execSync, spawn } from "node:child_process";
import { loadEnv } from "../../src/scripts/lib/load_env";

const env = loadEnv();
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const JARVIS_HOST = process.env.JARVIS_HOST ?? "jarvis-cf";
const WORKER = (process.env.ZERO_WORKER_URL ?? "https://zmail.bot").replace(/\/+$/, "");
const API_KEY = process.env.ZERO_API_KEY ?? "";
const CARLA_IMAGE = process.env.CARLA_IMAGE ?? "carlasim/carla:0.9.16";
const CARLA_PORT = Number(process.env.CARLA_PORT ?? "2000");
const CARLA_CONTAINER = "carla-sim";

interface CarlaScenario {
  name: string;
  map: string;
  vehicle_count: number;
  waypoints: Array<{ x: number; y: number; z?: number }>;
  duration_sec: number;
}

interface ScenarioResult {
  scenario_id: string;
  name: string;
  score: number;
  safety_violations: number;
  duration_ms: number;
  trace_count: number;
  breaches: Array<{ rule: string; severity: string }>;
}

// ─── SSH helpers ─────────────────────────────────────────────────────────

function ssh(cmd: string): string {
  return execSync(`ssh ${JARVIS_HOST} '${cmd}'`, { encoding: "utf8", timeout: 30_000 }).trim();
}

function sshBg(cmd: string): void {
  spawn("ssh", [JARVIS_HOST, cmd], { stdio: "ignore", detached: true }).unref();
}

// ─── CARLA lifecycle ─────────────────────────────────────────────────────

function carlaRunning(): boolean {
  try {
    const out = ssh(`docker ps --filter name=${CARLA_CONTAINER} --format '{{.Status}}'`);
    return out.includes("Up");
  } catch {
    return false;
  }
}

function startCarla(headless: boolean, map: string): void {
  if (carlaRunning()) {
    console.log(`[carla] Container ${CARLA_CONTAINER} already running`);
    return;
  }

  const flags = [
    headless ? "-RenderOffScreen" : "",
    headless ? "-nullrhi" : "",
    "-nosound",
    `-carla-rpc-port=${CARLA_PORT}`,
    `-carla-map=${map}`,
    "-quality-level=Low",
  ].filter(Boolean).join(" ");

  const dockerCmd = [
    "docker run -d --rm",
    `--name ${CARLA_CONTAINER}`,
    "--gpus all",
    "--ipc=host",
    "-p", `${CARLA_PORT}:${CARLA_PORT}`,
    "-p", `${CARLA_PORT + 1}:${CARLA_PORT + 1}`,
    "-p", `${CARLA_PORT + 2}:${CARLA_PORT + 2}`,
    CARLA_IMAGE,
    `./CarlaUE4.sh ${flags}`,
  ].join(" ");

  console.log(`[carla] Starting container on ${JARVIS_HOST}...`);
  sshBg(dockerCmd);
  console.log("[carla] Container starting (wait ~30s for ready)");
}

function stopCarla(): void {
  if (!carlaRunning()) {
    console.log("[carla] No running CARLA container");
    return;
  }
  ssh(`docker stop ${CARLA_CONTAINER}`);
  console.log("[carla] Container stopped");
}

// ─── Scenario runner ─────────────────────────────────────────────────────

function buildScenarioScript(scenario: CarlaScenario): string {
  const waypoints = scenario.waypoints.map((wp, i) =>
    `        (${wp.x}, ${wp.y}${wp.z !== undefined ? `, ${wp.z}` : ""})${i < scenario.waypoints.length - 1 ? "," : ""}`
  ).join("\n");

  return `
import carla
import time
import json
import sys

client = carla.Client("localhost", ${CARLA_PORT})
client.set_timeout(30.0)
world = client.load_world("${scenario.map}")
settings = world.get_settings()
settings.synchronous_mode = True
settings.fixed_delta_seconds = 0.05
world.apply_settings(settings)

bp_lib = world.get_blueprint_library()
vehicle_bp = bp_lib.filter("vehicle.*")[0]
waypoints = [
${waypoints}
]

spawn_point = carla.Transform(carla.Location(x=waypoints[0][0], y=waypoints[0][1], z=0.3))
vehicle = world.spawn_actor(vehicle_bp, spawn_point)

violations = []
trace_count = 0
t0 = time.time()

try:
    for wp in waypoints[1:]:
        target = carla.Location(x=wp[0], y=wp[1], z=wp[2] if len(wp) > 2 else 0.3)
        vehicle.set_autopilot(True)

        for _ in range(100):
            world.tick()
            trace_count += 1
            loc = vehicle.get_location()
            vel = vehicle.get_velocity()
            speed = (vel.x**2 + vel.y**2 + vel.z**2)**0.5

            if speed > 10:
                violations.append({"rule": "speed_limit", "severity": "minor"})

            dist = loc.distance(target)
            if dist < 2.0:
                break

            if time.time() - t0 > ${scenario.duration_sec}:
                break

        if time.time() - t0 > ${scenario.duration_sec}:
            break

finally:
    vehicle.destroy()
    dt = time.time() - t0
    result = {
        "name": "${scenario.name}",
        "map": "${scenario.map}",
        "duration_ms": int(dt * 1000),
        "trace_count": trace_count,
        "safety_violations": len(violations),
        "score": max(0.0, 1.0 - len(violations) * 0.1),
        "breaches": violations,
    }
    print(json.dumps(result, ensure_ascii=False))
`.trim();
}

function runScenario(scenario: CarlaScenario): ScenarioResult {
  const script = buildScenarioScript(scenario);

  // Write script to temp file on JARVIS
  const remotePath = `/tmp/carla_scenario_${Date.now()}.py`;
  ssh(`cat > ${remotePath} << 'PYEOF'\n${script}\nPYEOF`);

  console.log(`[carla] Running scenario: ${scenario.name} on map ${scenario.map}`);
  const t0 = Date.now();
  const output = ssh(`docker exec ${CARLA_CONTAINER} python3 ${remotePath}`);
  const durationMs = Date.now() - t0;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = { name: scenario.name, score: 0, safety_violations: 0, duration_ms: durationMs, trace_count: 0, breaches: [] };
  }

  // Clean up temp file
  ssh(`rm -f ${remotePath}`);

  return {
    scenario_id: `scenario_${Date.now()}`,
    name: scenario.name,
    score: (parsed.score as number) ?? 0,
    safety_violations: (parsed.safety_violations as number) ?? 0,
    duration_ms: (parsed.duration_ms as number) ?? durationMs,
    trace_count: (parsed.trace_count as number) ?? 0,
    breaches: (parsed.breaches as Array<{ rule: string; severity: string }>) ?? [],
  };
}

// ─── Strand emission ─────────────────────────────────────────────────────

async function emitStrand(eventKind: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const r = await fetch(`${WORKER}/api/v1/flywheel/${eventKind.includes("verify.") ? "verify/run" : "verify/status/0"}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) console.error(`[strand] emit ${eventKind} failed: ${r.status}`);
  } catch (e) {
    console.error(`[strand] emit ${eventKind} error: ${(e as Error).message}`);
  }
}

// ─── Default lawn-mowing scenario ────────────────────────────────────────

function makeLawnMowingScenario(name: string): CarlaScenario {
  return {
    name,
    map: "Mine01",
    vehicle_count: 1,
    waypoints: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 10 },
      { x: 20, y: 20 },
      { x: 30, y: 20 },
      { x: 30, y: 30 },
      { x: 40, y: 30 },
      { x: 40, y: 40 },
      { x: 50, y: 40 },
    ],
    duration_sec: 60,
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    const running = carlaRunning();
    console.log(JSON.stringify({ carla_running: running, host: JARVIS_HOST, container: CARLA_CONTAINER }));
    return;
  }

  if (args.includes("--stop")) {
    stopCarla();
    return;
  }

  const scenarioIdx = args.indexOf("--scenario");
  const scenarioName = scenarioIdx > -1 ? args[scenarioIdx + 1] : "lawn_nav_001";
  const headless = args.includes("--headless");
  const mapIdx = args.indexOf("--map");
  const map = mapIdx > -1 ? args[mapIdx + 1] : "Mine01";

  const scenario = makeLawnMowingScenario(scenarioName);
  if (mapIdx > -1) scenario.map = map;

  // Ensure CARLA is running
  if (!carlaRunning()) {
    startCarla(headless, scenario.map);
    console.log("[carla] Waiting 35s for CARLA to initialize...");
    await new Promise((r) => setTimeout(r, 35_000));
  }

  if (!carlaRunning()) {
    console.error("[carla] CARLA failed to start. Check JARVIS Docker logs.");
    process.exit(1);
  }

  // Emit started event
  await emitStrand("verify.scenario.started", {
    scenario: scenario.name,
    model_version: "baseline",
    robot_type: "mower",
  });

  // Run scenario
  const result = runScenario(scenario);
  console.log(JSON.stringify(result, null, 2));

  // Emit completed event
  await emitStrand("verify.scenario.completed", {
    scenario_id: result.scenario_id,
    name: result.name,
    score: result.score,
    safety_violations: result.safety_violations,
    duration_ms: result.duration_ms,
    trace_count: result.trace_count,
  });

  // Emit safety breaches
  for (const breach of result.breaches) {
    await emitStrand("verify.safety.breach", {
      scenario_id: result.scenario_id,
      rule: breach.rule,
      severity: breach.severity,
    });
  }
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
