// active_learning_queue.ts — Edge case store with uncertainty-prioritized query.
//
// Uses KV (prefix: flywheel:edge:) to avoid DO hot-spot contention.
// Priority = uncertainty × recency × robot_rarity.
// Follows existing KV access patterns (apikey_v1, llm_billing, project).

export interface EdgeRecord {
  edge_id: string;
  robot_id: string;
  frame_id: string;
  uncertainty: number;
  status: "pending" | "labeled" | "approved" | "rejected";
  label?: string;
  label_method?: "human" | "llm" | "auto";
  confidence?: number;
  gps?: { lat: number; lon: number };
  sensor_data_ref?: string;
  created_at: number;
  updated_at: number;
}

interface EdgeKV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }>; list_complete: boolean; cursor?: string }>;
  delete(key: string): Promise<void>;
}

const PREFIX = "flywheel:edge:";
const PENDING_INDEX = `${PREFIX}pending_ids`;

function edgeKey(edgeId: string): string {
  return `${PREFIX}${edgeId}`;
}

// ─── Priority scoring ────────────────────────────────────────────────────

function priorityScore(edge: EdgeRecord, robotFrequency: Map<string, number>): number {
  const recencyHours = Math.max(1, (Date.now() - edge.created_at) / 3_600_000);
  const rarity = 1 / Math.max(1, robotFrequency.get(edge.robot_id) ?? 1);
  return edge.uncertainty * (1 / Math.log(1 + recencyHours)) * (1 + rarity);
}

// ─── CRUD ────────────────────────────────────────────────────────────────

export async function enqueueEdge(kv: EdgeKV, edge: EdgeRecord): Promise<void> {
  await kv.put(edgeKey(edge.edge_id), JSON.stringify(edge));

  const raw = await kv.get(PENDING_INDEX);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(edge.edge_id)) {
    ids.push(edge.edge_id);
    await kv.put(PENDING_INDEX, JSON.stringify(ids));
  }
}

export async function getEdge(kv: EdgeKV, edgeId: string): Promise<EdgeRecord | null> {
  const raw = await kv.get(edgeKey(edgeId));
  return raw ? JSON.parse(raw) as EdgeRecord : null;
}

export async function updateEdgeStatus(
  kv: EdgeKV,
  edgeId: string,
  status: EdgeRecord["status"],
  extra?: { label?: string; label_method?: EdgeRecord["label_method"]; confidence?: number },
): Promise<void> {
  const edge = await getEdge(kv, edgeId);
  if (!edge) throw new Error(`Edge ${edgeId} not found`);

  edge.status = status;
  edge.updated_at = Date.now();
  if (extra?.label) edge.label = extra.label;
  if (extra?.label_method) edge.label_method = extra.label_method;
  if (extra?.confidence !== undefined) edge.confidence = extra.confidence;

  await kv.put(edgeKey(edgeId), JSON.stringify(edge));

  if (status !== "pending") {
    const raw = await kv.get(PENDING_INDEX);
    if (raw) {
      const ids: string[] = JSON.parse(raw);
      const filtered = ids.filter((id) => id !== edgeId);
      if (filtered.length !== ids.length) {
        await kv.put(PENDING_INDEX, JSON.stringify(filtered));
      }
    }
  }
}

// ─── Prioritized query ───────────────────────────────────────────────────

export async function queryPendingEdges(kv: EdgeKV, limit = 50): Promise<EdgeRecord[]> {
  const raw = await kv.get(PENDING_INDEX);
  if (!raw) return [];

  const ids: string[] = JSON.parse(raw);
  if (ids.length === 0) return [];

  const edges: EdgeRecord[] = [];
  for (const id of ids.slice(0, limit * 3)) {
    const edge = await getEdge(kv, id);
    if (edge && edge.status === "pending") edges.push(edge);
  }

  const robotFreq = new Map<string, number>();
  for (const e of edges) {
    robotFreq.set(e.robot_id, (robotFreq.get(e.robot_id) ?? 0) + 1);
  }

  edges.sort((a, b) => priorityScore(b, robotFreq) - priorityScore(a, robotFreq));
  return edges.slice(0, limit);
}

export async function countPendingEdges(kv: EdgeKV): Promise<number> {
  const raw = await kv.get(PENDING_INDEX);
  if (!raw) return 0;
  return JSON.parse(raw).length;
}

// ─── Self-play failure ingestion ──────────────────────────────────────────

export interface SelfPlayFailure {
  round_id: string;
  ts: number;
  query: string;
  expected_sku: string;
  expected_name: string;
  strategy: string;
  retrieved_skus: string[];
  recall_at_k: Record<number, number>;
  judge_score: number;
  failure_reason?: string;
}

export async function enqueueSelfPlayFailures(
  kv: EdgeKV,
  failures: SelfPlayFailure[],
): Promise<number> {
  let enqueued = 0;
  for (const f of failures) {
    const edgeId = `sp_${f.round_id}`;
    const edge: EdgeRecord = {
      edge_id: edgeId,
      robot_id: "mro-selfplay",
      frame_id: f.round_id,
      uncertainty: 1.0 - f.judge_score,
      status: "pending",
      label_method: "llm",
      confidence: f.judge_score,
      created_at: f.ts,
      updated_at: Date.now(),
    };
    await enqueueEdge(kv, edge);
    enqueued++;

    // Also store full failure detail in a separate KV key
    await kv.put(
      `flywheel:edge:${edgeId}:detail`,
      JSON.stringify(f),
    );
  }
  return enqueued;
}
