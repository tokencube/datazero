#!/usr/bin/env npx tsx
// flywheel_ingest_daemon.ts — Fleet telemetry ingestion daemon.
//
// Polls robot fleet telemetry endpoints, batch-inserts to Zero Worker
// strand via /api/v1/flywheel/telemetry/ingest, and flags edge cases
// for active learning via /api/v1/flywheel/edge/flag.
//
// Usage:
//   npx tsx src/scripts/flywheel_ingest_daemon.ts
//   npx tsx src/scripts/flywheel_ingest_daemon.ts --once    (single poll, no loop)
//   npx tsx src/scripts/flywheel_ingest_daemon.ts --interval 10  (poll every 10s)
//
// Environment:
//   ZERO_WORKER_URL  — Zero Worker base URL (default: https://zmail.bot)
//   ZERO_API_KEY     — zb_ API key for flywheel endpoints
//   FLEET_ENDPOINTS  — comma-separated robot telemetry URLs
//   UNCERTAINTY_THRESHOLD — min uncertainty to flag edge case (default: 0.7)

import { loadEnv } from "../../src/scripts/lib/load_env";

const env = loadEnv();
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v;
}

const WORKER = (process.env.ZERO_WORKER_URL ?? "https://zmail.bot").replace(/\/+$/, "");
const API_KEY = process.env.ZERO_API_KEY ?? "";
const FLEET_ENDPOINTS = (process.env.FLEET_ENDPOINTS ?? "").split(",").filter(Boolean);
const UNCERTAINTY_THRESHOLD = Number(process.env.UNCERTAINTY_THRESHOLD ?? "0.7");
const POLL_INTERVAL_SEC = Math.max(5, Number(process.env.POLL_INTERVAL_SEC ?? "30"));

interface RobotTelemetry {
  robot_id: string;
  ts: number;
  gps?: { lat: number; lon: number };
  imu?: { accel_x: number; accel_y: number; accel_z: number; gyro_x: number; gyro_y: number; gyro_z: number };
  camera_url?: string;
  uncertainty?: number;
  battery_pct?: number;
  mode?: string;
}

interface IngestResult {
  ok: boolean;
  data?: { batch_id: string; ingested: number; errors: number };
  error?: string;
}

async function fetchTelemetry(endpoint: string): Promise<RobotTelemetry[]> {
  try {
    const r = await fetch(`${endpoint}/telemetry`, {
      headers: API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) {
      console.error(`[ingest] ${endpoint} returned ${r.status}`);
      return [];
    }
    const data = await r.json() as { telemetry?: RobotTelemetry[] } | RobotTelemetry[];
    return Array.isArray(data) ? data : (data.telemetry ?? []);
  } catch (e) {
    console.error(`[ingest] ${endpoint} fetch error: ${(e as Error).message}`);
    return [];
  }
}

async function ingestBatch(robotId: string, frames: Record<string, unknown>[]): Promise<IngestResult> {
  try {
    const r = await fetch(`${WORKER}/api/v1/flywheel/telemetry/ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        robot_id: robotId,
        sensor: "telemetry",
        frames: frames.map((f, i) => ({
          robot_id: robotId,
          frame_id: `${robotId}_${f.ts ?? Date.now()}_${i}`,
          sensor_type: f.imu ? "imu" : f.gps ? "gps" : "camera",
          data_ref: f.camera_url ?? "",
          gps: f.gps,
          imu: f.imu,
          ts: f.ts ?? Date.now(),
        })),
      }),
    });
    return await r.json() as IngestResult;
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function flagEdge(robotId: string, frameId: string, uncertainty: number, gps?: { lat: number; lon: number }): Promise<void> {
  try {
    await fetch(`${WORKER}/api/v1/flywheel/edge/flag`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({ robot_id: robotId, frame_id: frameId, uncertainty, gps }),
    });
  } catch (e) {
    console.error(`[edge] flag failed for ${frameId}: ${(e as Error).message}`);
  }
}

async function poll(): Promise<{ ingested: number; edges: number }> {
  let totalIngested = 0;
  let totalEdges = 0;

  if (FLEET_ENDPOINTS.length === 0) {
    console.log("[ingest] No FLEET_ENDPOINTS configured — using mock data");
    const mockTelemetry: RobotTelemetry[] = [
      { robot_id: "mower-01", ts: Date.now(), gps: { lat: 22.3, lon: 114.1 }, battery_pct: 85, mode: "mowing", uncertainty: 0.15 },
      { robot_id: "mower-02", ts: Date.now(), gps: { lat: 22.31, lon: 114.12 }, battery_pct: 72, mode: "returning", uncertainty: 0.82 },
    ];

    for (const t of mockTelemetry) {
      const result = await ingestBatch(t.robot_id, [t]);
      if (result.ok) totalIngested += result.data?.ingested ?? 0;

      if ((t.uncertainty ?? 0) > UNCERTAINTY_THRESHOLD) {
        await flagEdge(t.robot_id, `${t.robot_id}_${t.ts}`, t.uncertainty!, t.gps);
        totalEdges++;
      }
    }
  } else {
    for (const endpoint of FLEET_ENDPOINTS) {
      const telemetry = await fetchTelemetry(endpoint);
      for (const t of telemetry) {
        const result = await ingestBatch(t.robot_id, [t]);
        if (result.ok) totalIngested += result.data?.ingested ?? 0;

        if ((t.uncertainty ?? 0) > UNCERTAINTY_THRESHOLD) {
          await flagEdge(t.robot_id, `${t.robot_id}_${t.ts}`, t.uncertainty!, t.gps);
          totalEdges++;
        }
      }
    }
  }

  return { ingested: totalIngested, edges: totalEdges };
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");
  const intervalIdx = process.argv.indexOf("--interval");
  const intervalSec = intervalIdx > -1 ? Number(process.argv[intervalIdx + 1]) || POLL_INTERVAL_SEC : POLL_INTERVAL_SEC;

  console.log(`[ingest] Worker: ${WORKER}`);
  console.log(`[ingest] Fleet endpoints: ${FLEET_ENDPOINTS.length || "(mock mode)"}`);
  console.log(`[ingest] Interval: ${intervalSec}s | Mode: ${once ? "once" : "loop"}`);

  do {
    const start = Date.now();
    const { ingested, edges } = await poll();
    const elapsed = Date.now() - start;
    console.log(`[ingest] ${new Date().toISOString()} ingested=${ingested} edges=${edges} latency=${elapsed}ms`);

    if (once) break;
    await new Promise((r) => setTimeout(r, Math.max(0, intervalSec * 1000 - elapsed)));
  } while (true);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
