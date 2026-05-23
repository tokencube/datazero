// routes_flywheel.ts — DataZero Studio API routes.
// Replaces the Phase 1 placeholder with real endpoints.
// Mounted by router.ts under the main Hono app.
//
// Routes:
//   GET  /datazero/                         — Studio page (SSR HTML)
//   GET  /api/v1/flywheel/status            — Full dashboard data
//   GET  /api/v1/flywheel/training/list     — Training runs
//   POST /api/v1/flywheel/training/start    — Launch training
//   POST /api/v1/flywheel/training/stop     — Stop training
//   GET  /api/v1/flywheel/training/log      — Training log tail
//   POST /api/v1/flywheel/telemetry/ingest   — Unified telemetry ingest
//   POST /api/v1/flywheel/annotation/ingest  — Annotation ingest (starlawn)
//   GET  /api/v1/flywheel/edge/list         — Edge cases
//   GET  /api/v1/flywheel/carla/scenarios   — CARLA scenarios
//   GET  /api/v1/flywheel/metrics           — Pipeline metrics
//   POST /api/v1/flywheel/report            — Email status report

import type { RouterApp } from "../../src/routes_helpers";
import { apiOk, apiErr, checkBootstrapToken } from "../../src/routes_helpers";
import { renderDataZeroStudio } from "./pages/datazero_studio";
import { getFlywheelStatus, type FlywheelStatus } from "../../mro/src/lib/mro_flywheel_status";
import { createLSClient, exportAnnotations } from "./lib/flywheel_label_ops";
import {
  getLedger,
  earnCredit,
  spendCredit,
  EMAIL_COST,
  CHALLENGE_CREDIT,
  type LedgerEntry,
  type CreditEvent,
} from "../../src/lib/credit_ledger";
import {
  createAnnotationChallenge,
  getAnnotationChallenge,
  submitAnnotationChallenge,
  validateChallenge,
  getChallengeResult,
  type AnnotationChallenge,
  type ChallengeResult,
} from "../../src/lib/agent_challenge";
import { doAppendStrand } from "../../src/lib/do_strand";
import { R2Readable, uint8ToBase64 } from "../../src/lib/r2_readable";
import { McapIndexedReader } from "@mcap/core";

export function registerRoutes(app: RouterApp): void {
  // ─── Page: DataZero Studio ──────────────────────────────────────────

  app.get("/datazero", async (c) => {
    const html = renderDataZeroStudio();
    return c.html(html);
  });

  app.get("/datazero/", async (c) => {
    const html = renderDataZeroStudio();
    return c.html(html);
  });

  // ─── GET /api/v1/flywheel/status — Full dashboard data ─────────────

  app.get("/api/v1/flywheel/status", async (c) => {
    try {
      // Gather data from all available sources
      const env = c.env as Record<string, unknown>;
      const jarvisUrl = (env.JARVIS_OLLAMA_URL as string) || "http://cube.zmail.bot:11434";

      // MRO flywheel status (strand events + ollama health)
      let mroFlywheel: FlywheelStatus | null = null;
      try {
        mroFlywheel = await getFlywheelStatus(env as Record<string, unknown> & { doFetch: (opts: Record<string, unknown>) => Promise<{ strands?: Array<{ ts?: number; payload?: Record<string, unknown> }>; ok: boolean }> }, jarvisUrl);
      } catch { /* best-effort */ }

      // GPU metrics from JARVIS HTTP bridge
      let gpus: Array<{ index: number; name: string; util_pct: number; mem_used_mib: number; mem_total_mib: number; temp_c: number }> = [];
      try {
        const gpuRes = await fetch("https://3.zmail.bot/bridge/gpu", { signal: AbortSignal.timeout(5000) });
        if (gpuRes.ok) {
          const gpuData = await gpuRes.json() as { gpus: typeof gpus };
          gpus = gpuData.gpus ?? [];
        }
      } catch { /* bridge unreachable */ }

      // Training runs from JARVIS HTTP bridge
      let trainings: Array<{ run_id: string; model: string; gpu: number; status: string; epochs: number }> = [];
      try {
        const trainRes = await fetch("https://3.zmail.bot/bridge/train/list", { signal: AbortSignal.timeout(5000) });
        if (trainRes.ok) {
          const trainData = await trainRes.json() as { runs: typeof trainings };
          trainings = trainData.runs ?? [];
        }
      } catch { /* bridge unreachable */ }

      // Count free GPUs
      const gpuFree = gpus.filter(g => g.mem_used_mib < 5000).length;
      const gpuTotal = gpus.length || 8;

      // CARLA fleet status (best-effort from cube.zmail.bot)
      let fleetStatus = "unknown";
      let fleetOnline = 0;
      let fleetCount = 0;
      let mcapCount = 0;
      let lastRecording = "N/A";

      try {
        // Check if foxglove bridge is reachable (indicates fleet is running)
        const fleetRes = await fetch("http://cube.zmail.bot:11434/api/ps", { signal: AbortSignal.timeout(3000) });
        if (fleetRes.ok) fleetStatus = "JARVIS online";
      } catch {
        fleetStatus = "zbox only";
      }

      // Build flywheel stages
      const flywheel = {
        stages: [
          { name: "Deploy", count: fleetCount, status: fleetCount > 0 ? "active" as const : "pending" as const },
          { name: "Ingest", count: mcapCount, status: mcapCount > 0 ? "active" as const : "pending" as const },
          { name: "Label", count: mroFlywheel?.queue_depth ?? 0, status: (mroFlywheel?.queue_depth ?? 0) > 0 ? "active" as const : "pending" as const },
          { name: "Train", count: trainings.length, status: trainings.length > 0 ? "active" as const : "pending" as const },
          { name: "Verify", count: mroFlywheel?.training_runs_total ?? 0, status: (mroFlywheel?.training_runs_total ?? 0) > 0 ? "complete" as const : "pending" as const },
          { name: "OTA", count: 0, status: "pending" as const },
          { name: "Deploy", count: 0, status: "pending" as const },
        ],
      };

      return apiOk({
        fleet_count: fleetCount || "--",
        fleet_online: fleetOnline,
        fleet_status: fleetStatus,
        active_trainings: trainings.length,
        gpu_free: gpuFree,
        gpu_total: gpuTotal,
        pending_edges: mroFlywheel?.queue_depth ?? 0,
        mcap_count: mcapCount || "--",
        last_mcap: lastRecording,
        paper_count: 3,
        feedback_7d: mroFlywheel?.feedback_count_7d ?? 0,
        feedback_total: mroFlywheel?.feedback_count_total ?? 0,
        strand_count: "--",
        uptime: fleetStatus === "unknown" ? "--" : "active",
        gpus,
        trainings,
        flywheel,
        carla: {
          fleet_status: fleetStatus,
          mcap_count: mcapCount,
          last_recording: lastRecording,
          scenarios: [
            { id: "fleet-003", map: "Town10HD_Opt", vehicles: 5, faults: 0, date: "2026-05-09" },
          ],
        },
        papers: [
          { title: "Paper 1 — Zero Architecture", status: "arXiv-ready", pdf: "/phd/papers/paper1.pdf" },
          { title: "Paper 2 — EmailIO Transformer", status: "internal review", pdf: "/phd/papers/paper2.pdf" },
          { title: "Paper 3 — MRO Retrieval", status: "revised", pdf: "/phd/papers/paper3.pdf" },
        ],
        infra: {
          zbox_status: "online",
          hk_status: "offline",
          nodes: [
            { name: "JARVIS", spec: `8×A100 80GB · ${gpuFree} free · HK Colo`, status: gpus.length > 0 ? "online" : "offline" },
            { name: "zbox", spec: "GTX 1070 · CARLA 0.9.16 · fleet sim", status: "online" },
            { name: "Zero Worker", spec: "CF Workers · zmail.bot · Hono", status: "online" },
            { name: "zero-hk", spec: "PhD compute · provisioning", status: "offline" },
          ],
        },
      });
    } catch (e) {
      return apiErr(`flywheel status failed: ${(e as Error).message}`, 503);
    }
  });

  // ─── Training endpoints ────────────────────────────────────────────

  app.get("/api/v1/flywheel/training/list", async (c) => {
    try {
      const res = await fetch("https://3.zmail.bot/bridge/train/list", { signal: AbortSignal.timeout(8000) });
      if (!res.ok) return apiErr("bridge unreachable", 503);
      const data = await res.json() as { runs: Array<Record<string, unknown>> };
      return apiOk(data.runs ?? []);
    } catch {
      return apiErr("bridge unreachable", 503);
    }
  });

  app.post("/api/v1/flywheel/training/start", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    let body: Record<string, unknown>;
    try {
      body = await c.req.json() as Record<string, unknown>;
    } catch {
      return apiErr("invalid json body", 400);
    }

    try {
      const res = await fetch("https://3.zmail.bot/bridge/train/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json() as { ok: boolean; run_id?: string; error?: string; log_file?: string; cmd?: string };
      if (!data.ok) return apiErr(data.error ?? "launch failed", 500);
      return apiOk({
        run_id: data.run_id,
        log_file: data.log_file,
        cmd: data.cmd,
      });
    } catch (e) {
      return apiErr(`training launch failed: ${(e as Error).message}`, 503);
    }
  });

  app.post("/api/v1/flywheel/training/stop", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    let body: { run_id?: string };
    try {
      body = await c.req.json() as { run_id?: string };
    } catch {
      return apiErr("invalid json body", 400);
    }

    try {
      await fetch("https://3.zmail.bot/bridge/train/stop", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ run_id: body.run_id }),
        signal: AbortSignal.timeout(8000),
      });
      return apiOk({ ok: true });
    } catch {
      return apiErr("bridge unreachable", 503);
    }
  });

  app.get("/api/v1/flywheel/training/log", async (c) => {
    const runId = c.req.query("run_id") || "latest";
    const lines = parseInt(c.req.query("lines") || "30");
    try {
      const res = await fetch(
        `https://3.zmail.bot/bridge/train/log?run_id=${encodeURIComponent(runId)}&lines=${lines}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const data = await res.json() as { log: string; path: string };
      return apiOk({ log: data.log, path: data.path });
    } catch {
      return apiErr("bridge unreachable", 503);
    }
  });

  // ─── Telemetry Ingest (Phase 2: Data collection unification) ────────

  app.post("/api/v1/flywheel/telemetry/ingest", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    let body: { robot_id?: string; sensor?: string; frames?: Array<Record<string, unknown>> };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }

    if (!body.robot_id || !body.frames?.length) {
      return apiErr("robot_id + frames[] required", 400);
    }

    const batchId = `ingest_${Date.now()}_${body.robot_id}`;
    let ingested = 0;
    let errors = 0;

    for (const frame of body.frames) {
      try {
        await doAppendStrand(c.env as { AGENT?: DurableObjectNamespace }, {
          event_kind: "telemetry.ingest",
          payload: {
            robot_id: body.robot_id,
            sensor: body.sensor || "telemetry",
            frame_id: frame.frame_id || `${body.robot_id}_${frame.ts || Date.now()}`,
            sensor_type: frame.sensor_type || "unknown",
            gps: frame.gps || null,
            imu: frame.imu || null,
            data_ref: frame.data_ref || "",
            ts: frame.ts || Date.now(),
            batch_id: batchId,
          },
        });
        ingested++;
      } catch {
        errors++;
      }
    }

    return apiOk({ batch_id: batchId, ingested, errors });
  });

  // ─── Edge cases (active learning queue) ──────────────────────────────

  app.get("/api/v1/flywheel/edge/list", async (c) => {
    try {
      const { doRecentTraces } = await import("../../src/lib/do_strand");
      const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
      const rows = await doRecentTraces(
        c.env as { AGENT?: DurableObjectNamespace },
        limit,
        "edge.flag",
      );
      return apiOk(rows);
    } catch {
      return apiOk([]);
    }
  });

  app.post("/api/v1/flywheel/edge/flag", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    let body: { robot_id?: string; frame_id?: string; uncertainty?: number; gps?: { lat: number; lon: number } };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }

    if (!body.robot_id || !body.frame_id) {
      return apiErr("robot_id + frame_id required", 400);
    }

    try {
      const id = await doAppendStrand(c.env as { AGENT?: DurableObjectNamespace }, {
        event_kind: "edge.flag",
        payload: {
          robot_id: body.robot_id,
          frame_id: body.frame_id,
          uncertainty: body.uncertainty ?? 0,
          gps: body.gps ?? null,
          flagged_at: Date.now(),
        },
      });
      return apiOk({ flagged: true, trace_id: id });
    } catch (e) {
      return apiErr(`edge flag failed: ${(e as Error).message}`, 500);
    }
  });

  // ─── CARLA scenarios ───────────────────────────────────────────────

  app.get("/api/v1/flywheel/carla/scenarios", async (c) => {
    return apiOk([
      { id: "fleet-003", map: "Town10HD_Opt", vehicles: 5, faults: 0, date: "2026-05-09" },
      { id: "fleet-002", map: "Town10HD_Opt", vehicles: 5, faults: 0, date: "2026-05-08" },
    ]);
  });

  // ─── Metrics ───────────────────────────────────────────────────────

  app.get("/api/v1/flywheel/metrics", async (c) => {
    try {
      const mroStatus = await getFlywheelStatus(
        c.env as Record<string, unknown> & { doFetch: (opts: Record<string, unknown>) => Promise<{ strands?: Array<{ ts?: number }>; ok: boolean }> },
        (c.env.JARVIS_OLLAMA_URL as string) || "http://cube.zmail.bot:11434",
      );
      return apiOk({
        feedback_total: mroStatus.feedback_count_total,
        feedback_7d: mroStatus.feedback_count_7d,
        queue_depth: mroStatus.queue_depth,
        training_runs: mroStatus.training_runs_total,
        model_status: mroStatus.model_status,
        model_versions: mroStatus.model_versions,
      });
    } catch {
      return apiErr("metrics unavailable", 503);
    }
  });

  // ─── Email report ──────────────────────────────────────────────────

  app.post("/api/v1/flywheel/report", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    try {
      // Build report data
      const jarvisUrl = (c.env.JARVIS_OLLAMA_URL as string) || "http://cube.zmail.bot:11434";
      const mroStatus = await getFlywheelStatus(
        c.env as Record<string, unknown> & { doFetch: (opts: Record<string, unknown>) => Promise<{ strands?: Array<{ ts?: number }>; ok: boolean }> },
        jarvisUrl,
      );

      // Send via Resend
      const resendKey = (c.env.RESEND_API_KEY as string) || "";
      if (!resendKey) return apiErr("RESEND_API_KEY not configured", 500);

      const adminEmail = (c.env.ADMIN_EMAIL as string) || "zhanjun@gmail.com";
      const now = new Date().toISOString().replace("T", " ").slice(0, 19);

      const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto">
<h2>DataZero Studio Report</h2>
<p><strong>${now} HKT</strong></p>
<h3>MRO Flywheel</h3>
<ul>
<li>Model: ${mroStatus.model_status}</li>
<li>Feedback (7d): ${mroStatus.feedback_count_7d}</li>
<li>Training runs: ${mroStatus.training_runs_total}</li>
<li>Queue depth: ${mroStatus.queue_depth}</li>
</ul>
<h3>Links</h3>
<p><a href="https://3.zmail.bot/datazero/">DataZero Studio</a></p>
<p style="color:#999;font-size:12px;margin-top:32px">Zmail · Agent Projects by Email</p>
</div>`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from: "Zero <zero@zmail.bot>",
          to: [adminEmail],
          cc: ["zero@zmail.bot"],
          subject: `DataZero Studio Report — ${now} HKT`,
          html,
        }),
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) return apiErr(`email send failed: ${res.status}`, 500);
      return apiOk({ sent: true, to: adminEmail });
    } catch (e) {
      return apiErr(`report failed: ${(e as Error).message}`, 503);
    }
  });

  // ─── Label Studio proxy endpoints (Phase 2) ────────────────────────

  function getLSClient(env: Record<string, unknown>) {
    const apiKey = (env.LABEL_STUDIO_API_KEY as string) || "";
    const baseUrl = (env.LABEL_STUDIO_URL as string) || "https://label.zmail.bot";
    if (!apiKey) return null;
    return createLSClient(apiKey, baseUrl);
  }

  app.get("/api/v1/flywheel/label/projects", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);
    const ls = getLSClient(c.env as Record<string, unknown>);
    if (!ls) return apiErr("LABEL_STUDIO_API_KEY not configured", 500);
    try {
      const projects = await ls.listProjects();
      return apiOk(projects);
    } catch (e) {
      return apiErr(`label studio: ${(e as Error).message}`, 503);
    }
  });

  app.get("/api/v1/flywheel/label/tasks", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);
    const projectId = parseInt(c.req.query("project_id") || "0");
    if (!projectId) return apiErr("project_id required", 400);
    const page = parseInt(c.req.query("page") || "1");
    const ls = getLSClient(c.env as Record<string, unknown>);
    if (!ls) return apiErr("LABEL_STUDIO_API_KEY not configured", 500);
    try {
      const result = await ls.listTasks(projectId, page);
      return apiOk(result);
    } catch (e) {
      return apiErr(`label studio: ${(e as Error).message}`, 503);
    }
  });

  app.post("/api/v1/flywheel/label/project", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);
    let body: { title?: string; label_config?: string };
    try { body = await c.req.json() as { title?: string; label_config?: string }; }
    catch { return apiErr("invalid json body", 400); }
    if (!body.title || !body.label_config) return apiErr("title + label_config required", 400);
    const ls = getLSClient(c.env as Record<string, unknown>);
    if (!ls) return apiErr("LABEL_STUDIO_API_KEY not configured", 500);
    try {
      const project = await ls.createProject(body.title, body.label_config);
      return apiOk(project);
    } catch (e) {
      return apiErr(`label studio: ${(e as Error).message}`, 503);
    }
  });

  app.post("/api/v1/flywheel/label/tasks/batch", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);
    let body: { project_id?: number; tasks?: Array<{ data: Record<string, unknown> }> };
    try { body = await c.req.json() as { project_id?: number; tasks?: Array<{ data: Record<string, unknown> }> }; }
    catch { return apiErr("invalid json body", 400); }
    if (!body.project_id || !body.tasks?.length) return apiErr("project_id + tasks[] required", 400);
    const ls = getLSClient(c.env as Record<string, unknown>);
    if (!ls) return apiErr("LABEL_STUDIO_API_KEY not configured", 500);
    try {
      const count = await ls.createTasksBatch(body.project_id, body.tasks);
      return apiOk({ created: count });
    } catch (e) {
      return apiErr(`label studio: ${(e as Error).message}`, 503);
    }
  });

  app.post("/api/v1/flywheel/label/predictions", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);
    let body: { project_id?: number; predictions?: Array<{ task: number; result: unknown[] }> };
    try { body = await c.req.json() as { project_id?: number; predictions?: Array<{ task: number; result: unknown[] }> }; }
    catch { return apiErr("invalid json body", 400); }
    if (!body.project_id || !body.predictions?.length) return apiErr("project_id + predictions[] required", 400);
    const ls = getLSClient(c.env as Record<string, unknown>);
    if (!ls) return apiErr("LABEL_STUDIO_API_KEY not configured", 500);
    try {
      const count = await ls.importPredictions(body.project_id, body.predictions);
      return apiOk({ imported: count });
    } catch (e) {
      return apiErr(`label studio: ${(e as Error).message}`, 503);
    }
  });

  // ─── Credit Ledger (public) ─────────────────────────────────────────

  app.get("/api/v1/ledger/agent/:pubkey_hex", async (c) => {
    const pubkeyHex = c.req.param("pubkey_hex");
    if (!pubkeyHex || !/^[0-9a-f]{64}$/i.test(pubkeyHex)) {
      return apiErr("invalid pubkey_hex (must be 64-char hex)", 400);
    }
    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);
    try {
      const ledger = await getLedger(kv, pubkeyHex.toLowerCase());
      return apiOk(ledger);
    } catch (e) {
      return apiErr(`ledger query failed: ${(e as Error).message}`, 500);
    }
  });

  // ─── Annotation Challenge (PoA) ─────────────────────────────────────

  app.post("/api/v1/agent/challenge/create", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    let body: { agent_pubkey_hex?: string; handle?: string; task_count?: number };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }
    if (!body.agent_pubkey_hex || !body.handle) {
      return apiErr("agent_pubkey_hex + handle required", 400);
    }

    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const challenge = await createAnnotationChallenge(kv, {
        agent_pubkey_hex: body.agent_pubkey_hex,
        handle: body.handle,
        taskCount: body.task_count,
      });
      return apiOk(challenge);
    } catch (e) {
      return apiErr(`challenge creation failed: ${(e as Error).message}`, 500);
    }
  });

  app.get("/api/v1/agent/challenge/:challenge_id", async (c) => {
    const challengeId = c.req.param("challenge_id");
    if (!challengeId) return apiErr("challenge_id required", 400);

    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const challenge = await getAnnotationChallenge(kv, challengeId);
      if (!challenge) return apiErr("challenge not found", 404);
      return apiOk(challenge);
    } catch (e) {
      return apiErr(`challenge query failed: ${(e as Error).message}`, 500);
    }
  });

  app.post("/api/v1/agent/challenge/:challenge_id/submit", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    const challengeId = c.req.param("challenge_id");
    let body: { agent_pubkey_hex?: string; submissions?: Array<{ task_id: number; labels: string[]; confidence: number }> };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }
    if (!body.agent_pubkey_hex || !body.submissions?.length) {
      return apiErr("agent_pubkey_hex + submissions[] required", 400);
    }

    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const result = await submitAnnotationChallenge(kv, {
        challenge_id: challengeId,
        agent_pubkey_hex: body.agent_pubkey_hex,
        submissions: body.submissions,
      });
      if (!result) return apiErr("challenge not found or already processed", 404);
      return apiOk(result);
    } catch (e) {
      return apiErr(`submission failed: ${(e as Error).message}`, 500);
    }
  });

  app.post("/api/v1/agent/challenge/:challenge_id/validate", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    const challengeId = c.req.param("challenge_id");
    let body: { validator_pubkey_hex?: string; votes?: Array<{ task_id: number; agreed: boolean }> };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }
    if (!body.validator_pubkey_hex || !body.votes?.length) {
      return apiErr("validator_pubkey_hex + votes[] required", 400);
    }

    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const result = await validateChallenge(kv, {
        challenge_id: challengeId,
        validator_pubkey_hex: body.validator_pubkey_hex,
        votes: body.votes,
      });
      if (!result) return apiErr("challenge not found or not in submitted state", 404);

      // If passed, emit credit.earn to strand via the emit helper
      if (result.passed && result.credit_earned > 0) {
        // Emit credit earn event (best-effort; strand may be unavailable)
        try {
          const doFetchMod = await import("../../src/lib/do_strand");
          await doFetchMod.doFetch(c.env as Record<string, unknown> & { doFetch: (opts: Record<string, unknown>) => Promise<{ ok: boolean }> }, "/strand", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              event_kind: "credit.earn",
              payload: {
                agent_pubkey_hex: result.agent_pubkey_hex,
                amount_cny: result.credit_earned,
                description: `Annotation challenge passed: ${challengeId}`,
                challenge_id: challengeId,
              },
              visibility: "public",
            }),
          });
        } catch { /* best-effort */ }
      }

      return apiOk(result);
    } catch (e) {
      return apiErr(`validation failed: ${(e as Error).message}`, 500);
    }
  });

  app.get("/api/v1/agent/challenges", async (c) => {
    const pubkeyHex = c.req.query("agent_pubkey_hex");
    if (!pubkeyHex) return apiErr("agent_pubkey_hex query param required", 400);

    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const { getAgentChallenges } = await import("../../src/lib/agent_challenge");
      const challenges = await getAgentChallenges(kv, pubkeyHex);
      return apiOk(challenges);
    } catch (e) {
      return apiErr(`query failed: ${(e as Error).message}`, 500);
    }
  });

  // ─── Leaderboard + Royalty + Public Ledger ───────────────────────────

  app.get("/api/v1/ledger/leaderboard", async (c) => {
    const period = (c.req.query("period") ?? "all") as "all" | "week" | "month";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const { getLeaderboard } = await import("../../src/lib/credit_ledger");
      const agents = await getLeaderboard(kv, period, limit);
      return apiOk(agents);
    } catch (e) {
      return apiErr(`leaderboard query failed: ${(e as Error).message}`, 500);
    }
  });

  app.get("/api/v1/ledger/royalties", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10), 100);
    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const { getRoyalties } = await import("../../src/lib/credit_ledger");
      const items = await getRoyalties(kv, limit);
      return apiOk(items);
    } catch (e) {
      return apiErr(`royalty query failed: ${(e as Error).message}`, 500);
    }
  });

  app.get("/api/v1/ledger/public", async (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
    const env = c.env as Record<string, unknown>;
    const kv = env.KV_AUTH_KEYPAIR as CreditKV | undefined;
    if (!kv) return apiErr("KV_AUTH_KEYPAIR not available", 503);

    try {
      const { getPublicLedger } = await import("../../src/lib/credit_ledger");
      const events = await getPublicLedger(kv, limit);
      return apiOk(events);
    } catch (e) {
      return apiErr(`public ledger query failed: ${(e as Error).message}`, 500);
    }
  });

  // ─── Inference Hallucination Guard (Innovation 1c) ──────────────────

  app.post("/api/v1/inference/cascade", async (c) => {
    try {
      const body = await c.req.json() as {
        query: string;
        domain: string;
        model_confidence: number;
        model_answer: string;
      };
      if (!body.query || !body.domain || body.model_confidence == null) {
        return apiErr("query, domain, model_confidence required", 400);
      }

      const domain = body.domain as import("./lib/training_uncertainty").DomainKind;
      const env = c.env as Record<string, unknown>;

      const cascadeConfig = (await import("../../src/lib/inference_hallucination_guard"))
        .DOMAIN_CASCADE[domain];
      if (!cascadeConfig) return apiErr(`unknown domain: ${body.domain}`, 400);

      const { runInferenceCascade } = await import("../../src/lib/inference_hallucination_guard");

      const result = await runInferenceCascade(body.query, domain, cascadeConfig, {
        modelConfidence: body.model_confidence,
        modelAnswer: body.model_answer || "",
        webSearch: async (q: string) => {
          try {
            const res = await fetch(
              `https://aigw.zmail.bot/search?q=${encodeURIComponent(q)}`,
              { signal: AbortSignal.timeout(5000) },
            );
            if (!res.ok) return [];
            const data = await res.json() as { results?: Array<{ url: string; title: string; snippet: string }> };
            return data.results ?? [];
          } catch { return []; }
        },
        wikiLookup: async (q: string, dom: import("./lib/training_uncertainty").DomainKind) => {
          // DataZero wiki cache — look up prior expert replies
          try {
            const kvDB = (env.KV_MRO_SKINS || env.KV_ADMIN_STATE) as { get: (k: string) => Promise<string | null> } | undefined;
            if (!kvDB) return [];
            const raw = await kvDB.get(`datazero_wiki:${dom}:${encodeURIComponent(q.slice(0, 60))}`);
            if (!raw) return [];
            return JSON.parse(raw) as import("../../src/lib/inference_hallucination_guard").EvidencePointer[];
          } catch { return []; }
        },
        sendEmail: async (opts) => {
          // Route through existing email infrastructure
          const res = await fetch("https://zmail.bot/api/email/send", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(opts),
          });
          if (!res.ok) throw new Error(`Email send failed: ${res.status}`);
          const data = await res.json() as { message_id: string };
          return data.message_id;
        },
        emit: async (event) => {
          try {
            await fetch("https://zmail.bot/api/strand/emit", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(event),
            });
            return 0;
          } catch { return 0; }
        },
      });

      return apiOk(result);
    } catch (e) {
      return apiErr(`inference cascade failed: ${(e as Error).message}`, 500);
    }
  });

  app.get("/api/v1/inference/hallucination/triggers", (c) => {
    const domain = c.req.query("domain") || "mower_vla";
    const { HALLUCINATION_TRIGGER_QUERIES, DOMAIN_HALLUCINATION_TARGETS } =
      require("../../src/lib/inference_hallucination_guard");
    const triggers = (HALLUCINATION_TRIGGER_QUERIES as Record<string, string[]>)[domain] ?? [];
    const targets = (DOMAIN_HALLUCINATION_TARGETS as Record<string, unknown>)[domain] ?? {};
    return apiOk({ domain, triggers, targets });
  });

  // ─── TDDQ Loop (Innovation 1a) ────────────────────────────────────────

  app.post("/api/v1/tddq/detect", async (c) => {
    try {
      const body = await c.req.json() as {
        current_ppl: number;
        baseline_ppl: number;
        gradient_norms: number[];
        top_confidence: number;
        domain: string;
        model_name?: string;
        information_value?: number;
        query_cost?: number;
      };
      if (body.current_ppl == null || body.baseline_ppl == null || !body.gradient_norms || body.top_confidence == null || !body.domain) {
        return apiErr("current_ppl, baseline_ppl, gradient_norms, top_confidence, domain required", 400);
      }

      const { detectKnowledgeGap, generateGapQuery } =
        await import("./lib/training_uncertainty");
      const domain = body.domain as import("./lib/training_uncertainty").DomainKind;

      const detection = detectKnowledgeGap({
        currentPpl: body.current_ppl,
        baselinePpl: body.baseline_ppl,
        gradientNorms: body.gradient_norms,
        topConfidence: body.top_confidence,
        domain,
        informationValue: body.information_value,
        queryCost: body.query_cost,
      });

      if (!detection.should_query) {
        return apiOk({
          loop_id: `tddq_${Date.now()}`,
          stage: "complete",
          detection,
          created_at: Date.now(),
          updated_at: Date.now(),
        });
      }

      const query = generateGapQuery(detection, {
        modelName: body.model_name || "unknown",
        trainingStep: 0,
        tokenContext: "",
      });

      return apiOk({
        loop_id: `tddq_${Date.now()}`,
        stage: "detecting",
        detection,
        query,
        created_at: Date.now(),
        updated_at: Date.now(),
      });
    } catch (e) {
      return apiErr(`TDDQ detection failed: ${(e as Error).message}`, 500);
    }
  });

  app.post("/api/v1/tddq/validate", async (c) => {
    try {
      const body = await c.req.json() as {
        replies: Array<{
          message_id: string;
          from_pubkey_hex: string;
          body_text: string;
          evidence_urls: string[];
          signature_valid: boolean;
        }>;
        domain: string;
      };
      if (!body.replies || !body.domain) {
        return apiErr("replies, domain required", 400);
      }

      const { validateReplies } = await import("./lib/tddq_loop");

      const validated = validateReplies(body.replies, body.domain as import("./lib/training_uncertainty").DomainKind);
      const accepted = validated.filter(r => r.accepted);

      if (accepted.length > 0) {
        const { prepareInjection } = await import("./lib/tddq_loop");
        const samples = prepareInjection(accepted, "");
        return apiOk({ validated, accepted, injection_samples: samples });
      }

      return apiOk({ validated, accepted: [], injection_samples: [] });
    } catch (e) {
      return apiErr(`TDDQ validation failed: ${(e as Error).message}`, 500);
    }
  });

  // ─── Annotation Ingest (Phase 3: starlawn → datazero pipeline) ──────
  //
  // Accepts annotation messages from starlawn MCAP recorder.
  // frame_id format: "{file_basename}:{hostname}:{log_time_ns}"
  // (injected by starlawn_record write_annotation_attachment)
  // Schema names: datazero.cuboid | datazero.polygon | datazero.trajectory | datazero.time_range
  // Aligned with datazero/zdata/annotations.py LanceDB tables.

  const ANNOTATION_SCHEMAS = ["datazero.cuboid", "datazero.polygon", "datazero.trajectory", "datazero.time_range"] as const;

  function parseFrameId(frameId: string): { file_basename: string; hostname: string; log_time_ns: string } | null {
    // format: "starlawn_20260518_120000.mcap:jetson:123456789"
    const parts = frameId.split(":");
    if (parts.length < 3) return null;
    // hostname may be the last part before the nanosecond timestamp,
    // but if the file_basename contains colons (unlikely), take last two as hostname:ts
    const log_time_ns = parts[parts.length - 1];
    const hostname = parts[parts.length - 2];
    const file_basename = parts.slice(0, parts.length - 2).join(":");
    if (!/^\d+$/.test(log_time_ns)) return null;
    return { file_basename, hostname, log_time_ns };
  }

  function annotationTypeFromSchema(schema: string): string {
    switch (schema) {
      case "datazero.cuboid": return "cuboid";
      case "datazero.polygon": return "polygon";
      case "datazero.trajectory": return "trajectory";
      case "datazero.time_range": return "time_range";
      default: return "unknown";
    }
  }

  app.post("/api/v1/flywheel/annotation/ingest", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    let body: {
      robot_id?: string;
      mcap_file?: string;
      annotations?: Array<{
        schema?: string;
        frame_id?: string;
        payload?: Record<string, unknown>;
      }>;
    };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }

    if (!body.robot_id || !body.annotations?.length) {
      return apiErr("robot_id + annotations[] required", 400);
    }

    const batchId = `annot_${Date.now()}_${body.robot_id}`;
    let ingested = 0;
    let errors = 0;
    const byType: Record<string, number> = {};

    for (const ann of body.annotations) {
      try {
        const schema = ann.schema || "datazero.cuboid";
        if (!ANNOTATION_SCHEMAS.includes(schema as typeof ANNOTATION_SCHEMAS[number])) {
          errors++;
          continue;
        }

        const annType = annotationTypeFromSchema(schema);
        const frameId = ann.frame_id || "";
        const parsed = parseFrameId(frameId);

        await doAppendStrand(c.env as { AGENT?: DurableObjectNamespace }, {
          event_kind: "annotation.ingest",
          payload: {
            robot_id: body.robot_id,
            annotation_type: annType,
            schema,
            mcap_file: body.mcap_file || parsed?.file_basename || "",
            frame_id: frameId,
            file_basename: parsed?.file_basename || "",
            hostname: parsed?.hostname || "",
            log_time_ns: parsed?.log_time_ns || "",
            payload: ann.payload || {},
            batch_id: batchId,
            ingested_at: Date.now(),
          },
        });
        ingested++;
        byType[annType] = (byType[annType] || 0) + 1;
      } catch {
        errors++;
      }
    }

    return apiOk({ batch_id: batchId, ingested, errors, by_type: byType });
  });

  // ─── Annotation Export (Phase 3.3: LS → zdata round-trip) ─────────

  app.post("/api/v1/flywheel/annotation/export", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    const apiKey = (c.env as Record<string, string>).LABEL_STUDIO_API_KEY;
    if (!apiKey) return apiErr("LABEL_STUDIO_API_KEY not configured", 500);

    const baseUrl = (c.env as Record<string, string>).LABEL_STUDIO_URL || "https://label.zmail.bot";

    let body: { dataset_name?: string; kinds?: string[] };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }

    const datasetName = body.dataset_name;
    if (!datasetName) return apiErr("dataset_name required", 400);

    const kinds = (body.kinds ?? ["cuboid", "polygon", "trajectory", "time_range"]) as
      ("cuboid" | "polygon" | "trajectory" | "time_range")[];

    try {
      const batch = await exportAnnotations(apiKey, baseUrl, datasetName, kinds);
      return apiOk(batch);
    } catch (e) {
      return apiErr(`export failed: ${(e as Error).message}`, 500);
    }
  });

  // ─── Self-Play endpoints (Flywheel P1) ──────────────────────────────────

  app.post("/api/v1/flywheel/selfplay/run", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    let body: { rounds?: number; dry_run?: boolean };
    try { body = await c.req.json() as typeof body; }
    catch { return apiErr("invalid json body", 400); }

    const rounds = Math.min(body.rounds ?? 10, 100);

    try {
      // Trigger self-play run via the daemon endpoint on zbox or local
      const selfplayUrl = (c.env.MRO_SELFPLAY_URL as string) || "http://localhost:7788/selfplay";
      const res = await fetch(selfplayUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rounds, dry_run: body.dry_run ?? false }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        return apiErr(`selfplay endpoint returned ${res.status}`, 503);
      }

      const data = await res.json() as {
        rounds: number;
        failures: number;
        failure_rate: number;
        avg_recall_10: number;
        results?: Array<Record<string, unknown>>;
      };

      // If not dry run, enqueue failures into active learning queue
      if (!body.dry_run && data.results) {
        const failures = data.results
          .filter((r) => r.failure)
          .map((r) => ({
            round_id: r.round_id as string,
            ts: r.ts as number,
            query: r.query as string,
            expected_sku: r.expected_sku as string,
            expected_name: r.expected_name as string,
            strategy: r.strategy as string,
            retrieved_skus: r.retrieved_skus as string[],
            recall_at_k: r.recall_at_k as Record<number, number>,
            judge_score: r.judge_score as number,
            failure_reason: r.failure_reason as string | undefined,
          }));

        if (failures.length > 0) {
          try {
            const { enqueueSelfPlayFailures } = await import("./lib/active_learning_queue");
            const kv = (c.env.KV_MRO_SKINS || c.env.KV_ADMIN_STATE) as {
              get(key: string): Promise<string | null>;
              put(key: string, value: string): Promise<void>;
              list(opts?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
              delete(key: string): Promise<void>;
            };
            if (kv) {
              const count = await enqueueSelfPlayFailures(kv, failures);
              return apiOk({ ...data, enqueued_failures: count });
            }
          } catch { /* best-effort */ }
        }
      }

      return apiOk(data);
    } catch (e) {
      return apiErr(`selfplay run failed: ${(e as Error).message}`, 503);
    }
  });

  app.get("/api/v1/flywheel/selfplay/stats", async (c) => {
    try {
      const env = c.env as Record<string, unknown>;
      const kv = (env.KV_MRO_SKINS || env.KV_ADMIN_STATE) as {
        get(key: string): Promise<string | null>;
        list(opts?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
      } | undefined;

      if (!kv) return apiErr("KV not available", 503);

      const { getStats } = await import("../../mro/src/lib/selfplay_store");
      const stats = await getStats(kv as Parameters<typeof getStats>[0], 1000);
      return apiOk(stats);
    } catch (e) {
      return apiErr(`selfplay stats failed: ${(e as Error).message}`, 503);
    }
  });

  app.get("/api/v1/flywheel/selfplay/failures", async (c) => {
    try {
      const env = c.env as Record<string, unknown>;
      const kv = (env.KV_MRO_SKINS || env.KV_ADMIN_STATE) as {
        get(key: string): Promise<string | null>;
        list(opts?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
      } | undefined;

      if (!kv) return apiErr("KV not available", 503);

      const limit = Math.min(parseInt(c.req.query("limit") || "50"), 200);
      const { getRecentFailures } = await import("../../mro/src/lib/selfplay_store");
      const failures = await getRecentFailures(kv as Parameters<typeof getRecentFailures>[0], limit);
      return apiOk(failures);
    } catch (e) {
      return apiErr(`selfplay failures query failed: ${(e as Error).message}`, 503);
    }
  });

  // ─── Retrain trigger endpoint (Flywheel P2) ──────────────────────────────

  app.post("/api/v1/flywheel/retrain/check", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    try {
      const env = c.env as Record<string, unknown>;
      const kv = (env.KV_MRO_SKINS || env.KV_ADMIN_STATE) as {
        get(key: string): Promise<string | null>;
        list(opts?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
      } | undefined;

      // Gather metrics from multiple sources
      let failureRate = 0;
      let pendingEdges = 0;

      if (kv) {
        try {
          const { getStats } = await import("../../mro/src/lib/selfplay_store");
          const stats = await getStats(kv as Parameters<typeof getStats>[0], 500);
          failureRate = stats.failure_rate;
        } catch { /* best-effort */ }

        try {
          const { countPendingEdges } = await import("./lib/active_learning_queue");
          pendingEdges = await countPendingEdges(kv as Parameters<typeof countPendingEdges>[0]);
        } catch { /* best-effort */ }
      }

      // Retraining triggers if failure rate > 30% or pending edges > 100
      const trigger = failureRate > 0.30 || pendingEdges > 100;
      let reason = "";
      let priority: "low" | "medium" | "high" = "low";

      if (failureRate > 0.50) {
        reason = `high self-play failure rate: ${(failureRate * 100).toFixed(0)}%`;
        priority = "high";
      } else if (failureRate > 0.30) {
        reason = `elevated self-play failure rate: ${(failureRate * 100).toFixed(0)}%`;
        priority = "medium";
      } else if (pendingEdges > 200) {
        reason = `active learning queue depth: ${pendingEdges} pending`;
        priority = "medium";
      } else if (pendingEdges > 100) {
        reason = `active learning queue growing: ${pendingEdges} pending`;
        priority = "low";
      }

      return apiOk({
        trigger,
        reason: reason || "no trigger condition met",
        priority,
        metrics: {
          selfplay_failure_rate: failureRate,
          active_learning_queue_depth: pendingEdges,
        },
        checked_at: Date.now(),
      });
    } catch (e) {
      return apiErr(`retrain check failed: ${(e as Error).message}`, 503);
    }
  });

  // ─── MCAP random access API (Gap #1) ──────────────────────────────────

  function getMcapReader(env: Record<string, unknown>, r2Key: string) {
    const bucket = (env.ZERO_R2 as {
      head(key: string): Promise<{ size: number } | null>;
      get(key: string, opts?: { range?: { offset: number; length?: number } }): Promise<{ bytes(): Promise<Uint8Array> } | null>;
    });
    return McapIndexedReader.Initialize({ readable: new R2Readable(bucket, r2Key) });
  }

  // GET /api/v1/flywheel/mcap/info?file=<r2_key>
  // Returns MCAP summary: topics, schemas, time range, chunk indexes, attachments
  app.get("/api/v1/flywheel/mcap/info", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    const file = c.req.query("file");
    if (!file) return apiErr("file query param required (r2_key)", 400);

    try {
      const reader = await getMcapReader(c.env as Record<string, unknown>, file);
      const topics = [...reader.channelsById.values()].map((ch) => ({
        id: ch.id,
        topic: ch.topic,
        schema_id: ch.schemaId,
        message_encoding: ch.messageEncoding,
      }));
      const schemas = [...reader.schemasById.entries()].map(([id, s]) => ({
        id,
        name: s.name,
        encoding: s.encoding,
        data: new TextDecoder().decode(s.data),
      }));
      const chunks = reader.chunkIndexes.map((ci) => ({
        start_time: ci.messageStartTime.toString(),
        end_time: ci.messageEndTime.toString(),
        offset: ci.chunkStartOffset.toString(),
        length: ci.chunkLength.toString(),
        message_count: ci.messageIndexLength,
        compression: ci.compression,
      }));
      const attachments = reader.attachmentIndexes.map((ai) => ({
        name: ai.name,
        media_type: ai.mediaType,
        start_time: ai.startTime.toString(),
        end_time: ai.endTime.toString(),
        offset: ai.offset.toString(),
        size: ai.dataSize.toString(),
      }));
      const stats = reader.statistics;

      return apiOk({
        file,
        header: { profile: reader.header.profile, library: reader.header.library },
        stats: stats
          ? {
              message_count: Number(stats.messageCount),
              channel_count: stats.channelCount,
              attachment_count: stats.attachmentCount,
              metadata_count: stats.metadataCount,
              chunk_count: stats.chunkCount,
              start_time: stats.messageStartTime.toString(),
              end_time: stats.messageEndTime.toString(),
            }
          : null,
        topics,
        schemas,
        chunks,
        attachments,
      });
    } catch (e) {
      return apiErr(`mcap info failed: ${(e as Error).message}`, 500);
    }
  });

  // GET /api/v1/flywheel/mcap/messages?file=<r2_key>&topic=X&start_time=&end_time=&limit=100
  // Time-range query: returns messages matching topic + time window
  app.get("/api/v1/flywheel/mcap/messages", async (c) => {
    const tokenOk = checkBootstrapToken(c.req.raw, c.env);
    if (!tokenOk) return apiErr("unauthorized", 403);

    const file = c.req.query("file");
    if (!file) return apiErr("file query param required (r2_key)", 400);

    const topic = c.req.query("topic") || undefined;
    const startTime = c.req.query("start_time");
    const endTime = c.req.query("end_time");
    const limit = Math.min(parseInt(c.req.query("limit") || "100"), 1000);

    try {
      const reader = await getMcapReader(c.env as Record<string, unknown>, file);
      const messages: Array<{
        topic: string;
        sequence: number;
        log_time: string;
        publish_time: string;
        data_b64: string;
        data_len: number;
      }> = [];

      const opts: {
        topics?: readonly string[];
        startTime?: bigint;
        endTime?: bigint;
      } = {};
      if (topic) opts.topics = [topic];
      if (startTime) opts.startTime = BigInt(startTime);
      if (endTime) opts.endTime = BigInt(endTime);

      for await (const msg of reader.readMessages(opts)) {
        messages.push({
          topic: msg.channel?.topic ?? "",
          sequence: msg.sequence,
          log_time: msg.logTime.toString(),
          publish_time: msg.publishTime.toString(),
          data_b64: uint8ToBase64(msg.data),
          data_len: msg.data.length,
        });
        if (messages.length >= limit) break;
      }

      return apiOk({ file, count: messages.length, messages });
    } catch (e) {
      return apiErr(`mcap messages failed: ${(e as Error).message}`, 500);
    }
  });

  // GET /api/v1/flywheel/mcap/bytes?file=<r2_key>&offset=<int>&size=<int>
  // Raw byte range read — for Foxglove streaming / chunk fetch
  app.get("/api/v1/flywheel/mcap/bytes", async (c) => {
    const file = c.req.query("file");
    if (!file) return apiErr("file query param required (r2_key)", 400);

    const offsetStr = c.req.query("offset");
    const sizeStr = c.req.query("size");
    if (!offsetStr || !sizeStr) return apiErr("offset and size required", 400);

    const offset = parseInt(offsetStr);
    const size = Math.min(parseInt(sizeStr), 16 * 1024 * 1024); // cap 16MB
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size <= 0) {
      return apiErr("invalid offset/size", 400);
    }

    try {
      const bucket = (c.env.ZERO_R2 as {
        get(key: string, opts?: { range?: { offset: number; length?: number } }): Promise<{ bytes(): Promise<Uint8Array> } | null>;
      });
      const obj = await bucket.get(file, { range: { offset, length: size } });
      if (!obj) return apiErr(`R2 object not found: ${file}`, 404);

      const bytes = await obj.bytes();
      return c.newResponse(bytes, 200, {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "x-r2-key": file,
        "x-byte-range": `bytes ${offset}-${offset + bytes.length - 1}`,
      });
    } catch (e) {
      return apiErr(`mcap bytes failed: ${(e as Error).message}`, 500);
    }
  });
}
