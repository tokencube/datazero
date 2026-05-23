// data_flywheel.ts — Every agent interaction → training data.
//
// Core loop: emit signal → strand LMAX → collect → export → train.
// Design spec: data_flywheel.contract.md
//
// Two tiers:
//   DoStrandEnv (lib/cron)  → doAppendStrand / doRecentTraces
//   SkillCtx   (skills)     → ctx.strand() / ctx.queryStrands()

import type { DoStrandEnv, DoTraceRow } from "../../src/lib/do_strand";
import { doAppendStrand, doRecentTraces } from "../../src/lib/do_strand";
import type { SkillCtx } from "../../src/kernel/skill";
import type { Strand } from "../../src/kernel/strand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const FLYWHEEL_EVENT_KIND = "zero.flywheel.signal" as const;

export type FlywheelSource = "@test" | "@deploy" | "@click" | "@email" | "@search" | "@code";
export type FlywheelResult = "success" | "failure" | "partial";

const VALID_SOURCES: ReadonlySet<string> = new Set([
  "@test",
  "@deploy",
  "@click",
  "@email",
  "@search",
  "@code",
]);

const MAX_CLOCK_SKEW_MS = 86_400_000; // 24h — generous for timezone issues

export interface FlywheelSignal {
  readonly source: FlywheelSource;
  readonly principal: string;
  readonly action: string;
  readonly result: FlywheelResult;
  readonly feedback?: string;
  readonly context: Record<string, unknown>;
  readonly ts: number;
}

export interface FlywheelStats {
  readonly total_signals: number;
  readonly by_source: Record<string, number>;
  readonly by_result: Record<string, number>;
  readonly human_feedback_rate: number;
  readonly last_export_ts: number | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateSignal(signal: FlywheelSignal): void {
  if (!signal.source || !VALID_SOURCES.has(signal.source)) {
    throw new Error(`invalid flywheel source: "${signal.source}"`);
  }
  if (!signal.principal || typeof signal.principal !== "string") {
    throw new Error("flywheel signal requires a non-empty principal");
  }
  if (!signal.action || typeof signal.action !== "string") {
    throw new Error("flywheel signal requires a non-empty action");
  }
  if (!signal.result || !["success", "failure", "partial"].includes(signal.result)) {
    throw new Error(`invalid flywheel result: "${signal.result}"`);
  }
  // Reject timestamps too far in the future (clock skew tolerance: 24h)
  if (signal.ts > Date.now() + MAX_CLOCK_SKEW_MS) {
    throw new Error("flywheel signal ts is too far in the future");
  }
}

// ---------------------------------------------------------------------------
// emitFlywheelSignal — write via AgentDO (lib/cron path)
// ---------------------------------------------------------------------------

export async function emitFlywheelSignal(
  env: DoStrandEnv,
  signal: FlywheelSignal,
): Promise<number> {
  validateSignal(signal);
  return doAppendStrand(env, {
    event_kind: FLYWHEEL_EVENT_KIND,
    payload: signal,
  });
}

// ---------------------------------------------------------------------------
// emitFlywheelSignalCtx — write via SkillCtx (skill handler path)
// ---------------------------------------------------------------------------

export async function emitFlywheelSignalCtx(
  ctx: SkillCtx,
  signal: FlywheelSignal,
): Promise<number> {
  validateSignal(signal);
  return ctx.strand({
    event_kind: FLYWHEEL_EVENT_KIND,
    payload: signal,
  });
}

// ---------------------------------------------------------------------------
// collectSignals — read via AgentDO (lib/cron path)
// ---------------------------------------------------------------------------

export async function collectSignals(
  env: DoStrandEnv,
  opts?: {
    source?: FlywheelSource;
    since?: number;
    limit?: number;
  },
): Promise<FlywheelSignal[]> {
  const rows = await doRecentTraces(
    env,
    opts?.limit ?? 50,
    FLYWHEEL_EVENT_KIND,
    undefined, // sinceId
    undefined, // maxId
  );

  let signals = rows.map((r) => r.payload as FlywheelSignal);

  if (opts?.source) {
    signals = signals.filter((s) => s.source === opts.source);
  }
  if (opts?.since) {
    signals = signals.filter((s) => s.ts >= opts.since!);
  }

  return signals;
}

// ---------------------------------------------------------------------------
// collectSignalsCtx — read via SkillCtx (skill handler path)
// ---------------------------------------------------------------------------

export async function collectSignalsCtx(
  ctx: SkillCtx,
  opts?: {
    source?: FlywheelSource;
    since?: number;
    limit?: number;
  },
): Promise<FlywheelSignal[]> {
  const strands = await ctx.queryStrands({
    event_kind: FLYWHEEL_EVENT_KIND,
    limit: opts?.limit ?? 50,
  });

  let signals = strands.map((s) => s.payload as FlywheelSignal);

  if (opts?.source) {
    signals = signals.filter((s) => s.source === opts.source);
  }
  if (opts?.since) {
    signals = signals.filter((s) => s.ts >= opts.since!);
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Training data export (ShareGPT / JSONL)
// ---------------------------------------------------------------------------

export interface TrainingExample {
  readonly id: string;
  readonly strandId: number;
  readonly eventKind: string;
  readonly instruction: string;
  readonly output: string;
  readonly agentId: string;
  readonly ts: number;
}

export interface ShareGPTExample {
  readonly id: string;
  readonly conversations: readonly {
    from: "human" | "gpt" | "system";
    value: string;
  }[];
}

export interface ExportTrainingOpts {
  readonly format: "sharegpt" | "nemo";
  readonly limit?: number;
  /** Which side of the 90/10 split to return. Omit to return all examples. */
  readonly split?: "train" | "val";
  readonly eventKinds?: string[];
  readonly systemPrompt?: string;
}

/** Minimal row shape shared by DoTraceRow (AgentDO) and Strand (DO storage). */
interface StrandRow {
  id: number;
  ts: number;
  event_kind: string;
  agent_id: string;
  payload: unknown;
}

const DEFAULT_TRAINING_KINDS = ["zero.flywheel.signal", "llm.chat"];

// ── Helpers ────────────────────────────────────────────────────────────

function stringify(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

function buildInstruction(
  eventKind: string,
  payload: Record<string, unknown>,
): string | null {
  // flywheel signal → action becomes the human instruction
  if (eventKind === FLYWHEEL_EVENT_KIND) {
    const action = stringify(payload.action);
    if (!action) return null;
    return action;
  }

  // llm.chat → extract the user message
  if (eventKind === "llm.chat") {
    const messages = payload.messages as
      | Array<{ role: string; content: string }>
      | undefined;
    if (messages) {
      const userMsg = messages.find((m) => m.role === "user");
      if (userMsg?.content) return userMsg.content;
    }
    return stringify(payload.query ?? payload.prompt) ?? null;
  }

  // MRO event kinds — ported from jarvis_train_bridge.ts
  const q = stringify(payload.q ?? payload.query);

  switch (eventKind) {
    case "mro.search.query": {
      if (!q) return null;
      return `Search the MRO catalog for industrial parts matching: "${q}"`;
    }
    case "mro.search.p1": {
      if (!q) return null;
      return `Run FTS5 (full-text segmentation) search on MRO catalog for: ${q}`;
    }
    case "mro.search.p2": {
      if (!q) return null;
      return `Run vector embedding similarity search on MRO catalog for: ${q}`;
    }
    case "mro.search.rrf": {
      if (!q) return null;
      return `Merge FTS5 and vector search results using Reciprocal Rank Fusion for query: ${q}`;
    }
    case "mro.search.repo.created": {
      if (!q) return null;
      return `Archive the search results for "${q}" as a permanent git branch in the MRO knowledge base`;
    }
    case "mro.search.repo.exists": {
      if (!q) return null;
      return `Check if a search branch already exists for query: "${q}"`;
    }
    case "mro.intake.classify":
      return `Classify this MRO inquiry: subject="${stringify(payload.subject)}", sender="${stringify(payload.sender_email)}"`;
    case "mro.six_tier.assign":
      return `Classify product "${stringify(payload.name)}" (brand: ${stringify(payload.brand)}) into the 6-tier MRO taxonomy`;
    case "mro.rfq.create":
      return `Create a Request for Quotation: SKU ${stringify(payload.sku)}, quantity ${stringify(payload.quantity)}`;
    case "mro.buyer.inquiry":
      return `Process buyer inquiry for part ${stringify(payload.part_no)} (qty: ${stringify(payload.qty)})`;
    default:
      return stringify(payload.instruction ?? payload.action ?? payload.query) ?? eventKind;
  }
}

function buildOutput(
  eventKind: string,
  payload: Record<string, unknown>,
): string | null {
  // flywheel signal → result + optional human feedback
  if (eventKind === FLYWHEEL_EVENT_KIND) {
    const result = stringify(payload.result);
    const feedback = stringify(payload.feedback);
    if (!result) return null;
    return [result, feedback].filter(Boolean).join(" — ");
  }

  // llm.chat → extract the assistant message
  if (eventKind === "llm.chat") {
    const messages = payload.messages as
      | Array<{ role: string; content: string }>
      | undefined;
    if (messages) {
      const asstMsg = messages.find((m) => m.role === "assistant");
      if (asstMsg?.content) return asstMsg.content;
    }
    return stringify(payload.response ?? payload.output) ??
      JSON.stringify(payload);
  }

  // MRO event kinds — ported from jarvis_train_bridge.ts
  const q = stringify(payload.q ?? payload.query) ?? "";
  const merged = Number(payload.merged ?? 0);
  const returned = Number(payload.returned ?? 0);
  const latencyMs = Number(payload.latency_ms ?? 0);
  const latencySec = latencyMs > 0 ? (latencyMs / 1000).toFixed(2) : null;

  switch (eventKind) {
    case "mro.search.query": {
      if (returned === 0) {
        return `No matching MRO parts found for "${q}". Try broadening your search terms or using a different keyword.`;
      }
      const latency = latencySec ? ` in ${latencySec}s` : "";
      return `Found ${returned} MRO product${returned > 1 ? "s" : ""} for "${q}"${latency}. The search queried the full catalog using 6-tier taxonomy classification.`;
    }
    case "mro.search.p1": {
      const hits = Number(payload.hits ?? 0);
      const status = stringify(payload.status) ?? "unknown";
      if (status === "error" || hits === 0) {
        return `FTS5 text search for "${q}" returned no hits. The catalog may not contain matching product names or descriptions.`;
      }
      return `FTS5 full-text search found ${hits} potential matches for "${q}" using Chinese/English segmentation and trigram indexing.`;
    }
    case "mro.search.p2": {
      const p2hits = Number(payload.hits ?? 0);
      const p2status = stringify(payload.status) ?? "unknown";
      if (p2status === "error" || p2hits === 0) {
        return `Vector similarity search for "${q}" returned no results. The embedding model may not have sufficient coverage for this query domain.`;
      }
      return `Vector embedding search found ${p2hits} semantically similar products for "${q}" using cosine similarity on Qwen3 embeddings.`;
    }
    case "mro.search.rrf": {
      const p1 = Number(payload.p1_contributed ?? 0);
      const p2 = Number(payload.p2_contributed ?? 0);
      return `Reciprocal Rank Fusion merged ${p1} FTS5 + ${p2} vector candidates into ${merged} unified results, returning top ${returned}.`;
    }
    case "mro.search.repo.created": {
      const slug = stringify(payload.slug) ?? "";
      const count = Number(payload.result_count ?? 0);
      return `Created search branch \`${slug}\` with ${count} MRO results committed to git.`;
    }
    case "mro.search.repo.exists": {
      const rslug = stringify(payload.slug) ?? "";
      return `Search branch \`${rslug}\` already exists — reusing cached results from the MRO knowledge base.`;
    }
    default:
      return JSON.stringify(payload);
  }
}

// ── Core processing (shared by both DoStrandEnv and SkillCtx variants) ──

function buildExamples(rows: StrandRow[]): TrainingExample[] {
  const examples: TrainingExample[] = [];
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const instruction = buildInstruction(row.event_kind, payload);
    const output = buildOutput(row.event_kind, payload);
    if (!instruction || !output) continue;

    examples.push({
      id: `strand_${row.id}`,
      strandId: row.id,
      eventKind: row.event_kind,
      instruction,
      output: typeof output === "string" ? output : JSON.stringify(output),
      agentId: row.agent_id,
      ts: row.ts,
    });
  }
  return examples;
}

function toJSONL(examples: TrainingExample[], opts: ExportTrainingOpts): string {
  examples.sort((a, b) => b.strandId - a.strandId);

  const shareGPT = toShareGPT(examples, opts.systemPrompt);

  // 90/10 train/val split
  const splitIdx = Math.floor(shareGPT.length * 0.9);
  const data =
    opts.split === "val"
      ? shareGPT.slice(splitIdx)
      : opts.split === "train"
        ? shareGPT.slice(0, splitIdx)
        : shareGPT;

  return data.map((e) => JSON.stringify(e)).join("\n") +
    (data.length > 0 ? "\n" : "");
}

export function toShareGPT(
  examples: TrainingExample[],
  systemPrompt?: string,
): ShareGPTExample[] {
  return examples.map((ex) => ({
    id: ex.id,
    conversations: systemPrompt
      ? [
          { from: "system" as const, value: systemPrompt },
          { from: "human" as const, value: ex.instruction },
          { from: "gpt" as const, value: ex.output },
        ]
      : [
          { from: "human" as const, value: ex.instruction },
          { from: "gpt" as const, value: ex.output },
        ],
  }));
}

// ── DoStrandEnv variant ────────────────────────────────────────────────

/** Export strands as ShareGPT/NeMo JSONL training data via AgentDO. */
export async function exportTrainingData(
  env: DoStrandEnv,
  opts: ExportTrainingOpts,
): Promise<string> {
  const kinds = opts.eventKinds ?? [...DEFAULT_TRAINING_KINDS];
  const limit = opts.limit ?? 5000;
  const limitPerKind = Math.ceil(limit / kinds.length);

  const batchResults = await Promise.all(
    kinds.map((kind) =>
      doRecentTraces(env, limitPerKind, kind).catch((): DoTraceRow[] => []),
    ),
  );

  // Deduplicate by strand id (same strand may match multiple kind filters)
  const seen = new Set<number>();
  const rows: StrandRow[] = [];
  for (const batch of batchResults) {
    for (const r of batch) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
  }

  const examples = buildExamples(rows);
  return toJSONL(examples, opts);
}

// ── SkillCtx variant ───────────────────────────────────────────────────

/** Export strands as ShareGPT/NeMo JSONL training data via SkillCtx. */
export async function exportTrainingDataCtx(
  ctx: SkillCtx,
  opts: ExportTrainingOpts,
): Promise<string> {
  const kinds = opts.eventKinds ?? [...DEFAULT_TRAINING_KINDS];
  const limit = opts.limit ?? 5000;
  const limitPerKind = Math.ceil(limit / kinds.length);

  const batchResults = await Promise.all(
    kinds.map((kind) =>
      ctx.queryStrands({ event_kind: kind, limit: limitPerKind }).catch((): Strand[] => []),
    ),
  );

  const seen = new Set<number>();
  const rows: StrandRow[] = [];
  for (const batch of batchResults) {
    for (const r of batch) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        rows.push(r);
      }
    }
  }

  const examples = buildExamples(rows);
  return toJSONL(examples, opts);
}

// ---------------------------------------------------------------------------
// flywheelHealthCheck
// ---------------------------------------------------------------------------

export async function flywheelHealthCheck(
  env: DoStrandEnv,
): Promise<{ ok: boolean; signals_24h: number; export_age_h: number | null }> {
  const rows = await doRecentTraces(env, 1000, FLYWHEEL_EVENT_KIND);
  const now = Date.now();
  const dayAgo = now - 86_400_000;

  const signals24h = rows.filter((r) => (r.payload as FlywheelSignal).ts >= dayAgo).length;

  // Find the most recent export-like strand (training run completed)
  const exports = rows.filter(
    (r) =>
      r.event_kind === "training.run.complete" ||
      (r.payload as Record<string, unknown>)?.export_ts,
  );

  let exportAgeH: number | null = null;
  if (exports.length > 0) {
    const latest = exports.reduce((a, b) => (a.ts > b.ts ? a : b));
    exportAgeH = (now - latest.ts) / 3_600_000;
  }

  return {
    ok: signals24h > 0,
    signals_24h: signals24h,
    export_age_h: exportAgeH,
  };
}
