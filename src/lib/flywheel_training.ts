// flywheel_training.ts — JARVIS GPU query + training management via HTTP bridge.
// The Zero Worker calls a small HTTP bridge on JARVIS (train-http-bridge.py)
// that wraps nvidia-smi and docker exec. No SSH from Worker.

export interface GPUInfo {
  index: number;
  name: string;
  util_pct: number;
  mem_used_mib: number;
  mem_total_mib: number;
  temp_c: number;
}

export interface TrainingRun {
  run_id: string;
  model: string;
  dataset: string;
  gpu: number;
  status: "pending" | "running" | "completed" | "failed";
  epochs: number;
  current_step?: number;
  total_steps?: number;
  loss?: number;
  eta_h?: number;
  started_at?: number;
  log_file?: string;
}

// JARVIS HTTP bridge — a tiny Python/Node server on JARVIS that wraps
// nvidia-smi + docker exec. Served via Caddy on port 8000 or direct.
const BRIDGE_URL = "https://3.zmail.bot/bridge"; // JARVIS HTTP bridge via CF Tunnel → Caddy

async function bridgeCall<T>(path: string, opts?: { method?: string; body?: unknown; timeout?: number }): Promise<T | null> {
  const url = `${BRIDGE_URL}${path}`;
  try {
    const init: RequestInit = {
      method: opts?.method ?? "GET",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(opts?.timeout ?? 8000),
    };
    if (opts?.body) init.body = JSON.stringify(opts.body);
    const r = await fetch(url, init);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export async function getGPUMetrics(): Promise<GPUInfo[]> {
  const data = await bridgeCall<{ gpus: GPUInfo[] }>("/gpu");
  return data?.gpus ?? [];
}

export async function listTrainings(): Promise<TrainingRun[]> {
  const data = await bridgeCall<{ runs: TrainingRun[] }>("/train/list");
  return data?.runs ?? [];
}

export async function startTraining(cfg: {
  model: string;
  dataset: string;
  gpu: number;
  epochs: number;
  batch_size?: number;
  lora_rank?: number;
  output_dir: string;
}): Promise<{ ok: boolean; run_id?: string; error?: string }> {
  const data = await bridgeCall<{ ok: boolean; run_id?: string; error?: string }>(
    "/train/start",
    { method: "POST", body: cfg, timeout: 15000 },
  );
  return data ?? { ok: false, error: "bridge unreachable" };
}

export async function stopTraining(runId: string): Promise<{ ok: boolean }> {
  const data = await bridgeCall<{ ok: boolean }>("/train/stop", {
    method: "POST",
    body: { run_id: runId },
  });
  return data ?? { ok: false };
}

export async function getTrainingLog(runId: string, lines = 30): Promise<string> {
  const data = await bridgeCall<{ log: string }>(`/train/log?run_id=${encodeURIComponent(runId)}&lines=${lines}`);
  return data?.log ?? "bridge unreachable";
}
