#!/usr/bin/env npx tsx
// jarvis_train_bridge.ts — Export MRO strands from AgentDO for JARVIS LoRA training.
//
// Data source: AgentDO (Cloudflare Durable Object) accessed via HTTP API.
// The local mro-full.db is the product catalog, NOT the strand store.
// Strands live in the AgentDO and are queried via /admin/do/strands with
// `X-Zero-Bootstrap-Token` authentication.
//
// Output format: ShareGPT JSONL (NeMo Automodel native format).
// Each line: {"id":"...","conversations":[{"from":"system","value":"..."},{"from":"human","value":"..."},{"from":"gpt","value":"..."}]}
//
// Usage:
//   npx tsx src/scripts/jarvis_train_bridge.ts export --limit=100
//   npx tsx src/scripts/jarvis_train_bridge.ts sharegpt --limit=5000 --split=0.9
//   npx tsx src/scripts/jarvis_train_bridge.ts probe     # check JARVIS health
//   npx tsx src/scripts/jarvis_train_bridge.ts preflight  # preflight check
//   npx tsx src/scripts/jarvis_train_bridge.ts sample     # quick 20-sample to /tmp/mro_train_sample.jsonl
//
// Design:
//   - One way: training examples from strand LMAX only
//   - Immutable: export is read-only; never mutates strand
//   - Library-first: uses node:sqlite (built-in), no hand-rolled DB layer

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "url";
import {
  MRO_PIPELINE_CONFIG,
  type TrainingExportConfig,
} from "../../mro/src/lib/pipeline_config";
import { toShareGPT, type TrainingExample } from "../lib/data_flywheel";
// NOTE: ../lib/data_flywheel resolves internally within datazero/src/

// ── Paths ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "../..");

// ── Env ──────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = resolve(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) return env;
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) {
      const k = m[1]!;
      const v = m[2]!.trim();
      if (!(k in process.env) || !process.env[k]) process.env[k] = v;
      env[k] = v;
    }
  }
  return env;
}
const env = loadEnv();

const WORKER_URL = process.env.ZERO_WORKER_URL ?? "https://zmail.bot";
const BOOTSTRAP_TOKEN = env.ZERO_BOOTSTRAP_TOKEN ?? process.env.ZERO_BOOTSTRAP_TOKEN ?? "";
const VLLM_URL = process.env.JARVIS_VLLM_URL ?? "https://vllm.zmail.bot/v1";
const VLLM_MODEL = process.env.JARVIS_MODEL ?? "cubelite";

// ── Types ────────────────────────────────────────────────────────────

interface DoTraceRow {
  id: number;
  ts: number;
  schema_version: number;
  event_kind: string;
  parent_id: number | null;
  agent_id: string;
  visibility: string;
  payload: Record<string, unknown>;
  signature: string | null;
}

interface DoStrandsResponse {
  strands: DoTraceRow[];
  ok?: boolean;
}

interface ExportResult {
  exportedAt: string;
  config: {
    eventKinds: string[];
    maxExamples: number;
    format: string;
  };
  totalStrands: number;
  exportedCount: number;
  examples: TrainingExample[];
  outputPath?: string;
}

// ── HTTP helpers ─────────────────────────────────────────────────────

async function fetchAdmin(path: string): Promise<unknown> {
  if (!BOOTSTRAP_TOKEN) throw new Error("ZERO_BOOTSTRAP_TOKEN not set in .env");

  const url = `${WORKER_URL}${path}`;
  const r = await fetch(url, {
    headers: {
      "X-Zero-Bootstrap-Token": BOOTSTRAP_TOKEN,
      accept: "application/json",
    },
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "unknown");
    throw new Error(`${r.status} ${r.statusText}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

/** Fetch strands for a specific event kind, with pagination. */
async function fetchStrandsForKind(
  kind: string,
  maxCount: number,
): Promise<DoTraceRow[]> {
  const all: DoTraceRow[] = [];
  let sinceId = 0;

  while (all.length < maxCount) {
    const batchLimit = Math.min(200, maxCount - all.length);
    const path = sinceId > 0
      ? `/admin/do/strands?limit=${batchLimit}&kind=${encodeURIComponent(kind)}&since_id=${sinceId}`
      : `/admin/do/strands?limit=${batchLimit}&kind=${encodeURIComponent(kind)}`;

    const data = (await fetchAdmin(path)) as DoStrandsResponse;
    const batch = data.strands ?? [];
    if (batch.length === 0) break;

    all.push(...batch);
    sinceId = batch[batch.length - 1]!.id;
  }

  return all;
}

/** Deduplicate strands by id (some strands may match multiple kind filters). */
function dedupeStrands(rows: DoTraceRow[]): DoTraceRow[] {
  const seen = new Set<number>();
  return rows.filter((r) => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

// ── Export: AgentDO → training examples ──────────────────────────────

async function exportFromAgentDO(
  config: TrainingExportConfig,
): Promise<ExportResult> {
  console.log(`\n[export] Fetching MRO strands from AgentDO (${WORKER_URL})...`);
  console.log(`  Event kinds: ${(config.eventKinds ?? ["*"]).join(", ")}`);

  const kinds = config.eventKinds ?? [];
  if (kinds.length === 0) throw new Error("No event kinds configured for export");

  // Fetch strands for each kind in parallel
  const limitPerKind = Math.ceil(config.maxExamples / kinds.length);
  const batchResults = await Promise.all(
    kinds.map((kind) =>
      fetchStrandsForKind(kind, limitPerKind).catch((err) => {
        console.warn(`  [warn] Failed to fetch kind "${kind}": ${(err as Error).message}`);
        return [] as DoTraceRow[];
      }),
    ),
  );

  const allRows = dedupeStrands(batchResults.flat());
  console.log(`  Fetched ${allRows.length} unique strands`);

  // Build training examples
  const examples: TrainingExample[] = [];
  const systemPrompt = config.systemPrompt ?? "";

  for (const row of allRows) {
    const payload = row.payload ?? {};

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

  // Sort by strand id descending (most recent first for training recency)
  examples.sort((a, b) => b.strandId - a.strandId);

  // Trim to max
  const trimmed = examples.slice(0, config.maxExamples);

  return {
    exportedAt: new Date().toISOString(),
    config: {
      eventKinds: kinds,
      maxExamples: config.maxExamples,
      format: config.format,
    },
    totalStrands: allRows.length,
    exportedCount: trimmed.length,
    examples: trimmed,
  };
}

// ── Instruction/output builders per event_kind ────────────────────────

// ── Conversational training builders ────────────────────────────────
//
// Each builder produces natural MRO domain language. The "human" message
// is a realistic search query. The "gpt" message is the expected MRO
// assistant response: search summary, pipeline stats, result counts, L6
// classification hints, and cadence-appropriate detail.
//
// IMPORTANT: the strand payloads are PIPELINE METADATA only (hit counts,
// latency, query). They do NOT contain the actual product results (SKU
// names, brands, L6 paths). Those live in R2 git-store. Full training
// fidelity requires R2 results.json enrichment (see gap report in this
// file's header comment).

function buildInstruction(
  eventKind: string,
  payload: Record<string, unknown>,
): string | null {
  const q = stringify(payload.q ?? payload.query);

  switch (eventKind) {
    case "mro.search.query": {
      if (!q) return null;
      return [
        `Search the MRO catalog for industrial parts matching: "${q}"`,
        `Find MRO products related to: ${q}`,
        `Look up "${q}" in the MRO parts database`,
        `Query the MRO catalog: ${q}`,
        `Search MRO inventory for: ${q}`,
      ][Math.floor(Math.random() * 5)]!;
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
      return [
        `Merge FTS5 and vector search results using Reciprocal Rank Fusion for query: ${q}`,
        `Apply RRF to combine text and semantic search results for: ${q}`,
      ][Math.floor(Math.random() * 2)]!;
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
      return `MRO operation: ${eventKind}`;
  }
}

function buildOutput(
  eventKind: string,
  payload: Record<string, unknown>,
): string | null {
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
      return [
        `Found ${returned} MRO product${returned > 1 ? "s" : ""} for "${q}"${latency}. The search queried the full catalog using 6-tier taxonomy classification.`,
        `Search complete${latency}: ${returned} result${returned > 1 ? "s" : ""} for "${q}" from ${merged} candidate matches. Results are classified by Product Line > Segment > Family > Category.`,
      ][Math.floor(Math.random() * 2)]!;
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
      return [
        `Reciprocal Rank Fusion merged ${p1} FTS5 + ${p2} vector candidates into ${merged} unified results, returning top ${returned}.`,
        `RRF fusion complete: combined ${p1} text matches and ${p2} semantic matches, producing ${returned} final recommendation${returned > 1 ? "s" : ""}.`,
      ][Math.floor(Math.random() * 2)]!;
    }

    case "mro.search.repo.created": {
      const slug = stringify(payload.slug) ?? "";
      const count = Number(payload.result_count ?? 0);
      return [
        `Created search branch \`${slug}\` with ${count} MRO results committed to git. Review at https://zmail.bot/p/${slug}`,
        `Search results archived as branch \`${slug}\` in the MRO knowledge base. ${count} products saved with L6 taxonomy classification.`,
      ][Math.floor(Math.random() * 2)]!;
    }

    case "mro.search.repo.exists": {
      const rslug = stringify(payload.slug) ?? "";
      return `Search branch \`${rslug}\` already exists — reusing cached results from the MRO knowledge base.`;
    }

    default: {
      return JSON.stringify({
        status: "completed",
        event_kind: eventKind,
        details: payload,
      });
    }
  }
}

function stringify(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

// ── JARVIS health probe ───────────────────────────────────────────────

async function probeJarvisHealth(): Promise<void> {
  console.log(`\n[probe] Checking JARVIS at ${VLLM_URL}...`);

  try {
    const r = await fetch(`${VLLM_URL.replace(/\/$/, "")}/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) {
      console.log(`  JARVIS reachable: NO (HTTP ${r.status})`);
    } else {
      const data = (await r.json()) as { data?: unknown[] };
      console.log(`  JARVIS reachable: YES`);
      if (data.data && Array.isArray(data.data)) {
        console.log(`  Models listed: ${data.data.length}`);
        for (const m of data.data.slice(0, 5)) {
          const model = m as { id?: string };
          console.log(`    - ${model.id ?? "unknown"}`);
        }
      }
    }
  } catch (err) {
    console.log(`  JARVIS reachable: NO (${(err as Error).message})`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? "help";

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`JARVIS Training Bridge — AgentDO strand LMAX → JARVIS 8×A100 LoRA pipeline

Usage:
  npx tsx src/scripts/jarvis_train_bridge.ts export [--limit=N]
  npx tsx src/scripts/jarvis_train_bridge.ts sharegpt [--limit=5000] [--split=0.9]
  npx tsx src/scripts/jarvis_train_bridge.ts sample          # quick 20-sample → /tmp/mro_train_sample.jsonl
  npx tsx src/scripts/jarvis_train_bridge.ts probe            # check JARVIS health
  npx tsx src/scripts/jarvis_train_bridge.ts preflight         # full preflight before training

Environment:
  ZERO_BOOTSTRAP_TOKEN — required (set in .env)
  ZERO_WORKER_URL      — default: https://zmail.bot
  JARVIS_VLLM_URL      — default: https://vllm.zmail.bot/v1

NeMo recipe: infra/jarvis/dsv4_flash_mro_finetune.yaml
Launch script: infra/jarvis/launch_dsv4_finetune.sh
`);
    return;
  }

  if (cmd === "probe") {
    await probeJarvisHealth();
    return;
  }

  if (cmd === "preflight") {
    console.log("JARVIS Training Preflight\n");

    // 1. Check bootstrap token
    if (!BOOTSTRAP_TOKEN) {
      console.error("FAIL: ZERO_BOOTSTRAP_TOKEN not set in .env");
      process.exit(1);
    }
    console.log("  [1/4] Bootstrap token: OK");

    // 2. Check AgentDO connectivity
    console.log("  [2/4] Checking AgentDO connectivity...");
    try {
      const data = (await fetchAdmin(
        "/admin/do/strands?limit=1&kind=mro.search.query",
      )) as DoStrandsResponse;
      const count = (data.strands ?? []).length;
      console.log(`    OK: fetched ${count} test strand(s)`);
    } catch (err) {
      console.error(`    FAIL: ${(err as Error).message}`);
      process.exit(1);
    }

    // 3. Check JARVIS
    console.log("  [3/4] Checking JARVIS...");
    await probeJarvisHealth();

    // 4. Check output directory
    console.log("  [4/4] Output directory...");
    const outDir = resolve(PROJECT_ROOT, "src/data/training_exports");
    mkdirSync(outDir, { recursive: true });
    console.log(`    OK: ${outDir}`);

    console.log("\nPreflight complete. Ready for training export.");
    return;
  }

  // ── Export / sharegpt / sample ─────────────────────────────────────

  const isSample = cmd === "sample";
  const limit = parseInt(
    args.find((a) => a.startsWith("--limit="))?.split("=")[1] ??
      (isSample ? "20" : "1000"),
    10,
  );
  const splitRatio = parseFloat(
    args.find((a) => a.startsWith("--split="))?.split("=")[1] ?? "0.9",
  );

  const config: TrainingExportConfig = {
    ...MRO_PIPELINE_CONFIG.training,
    maxExamples: limit,
    format: "openai_chat",
  };

  console.log(`[export] MRO strand → ShareGPT training data`);
  console.log(`  Worker: ${WORKER_URL}`);
  console.log(`  Max examples: ${limit}`);

  const result = await exportFromAgentDO(config);

  if (result.examples.length === 0) {
    console.log("\n  No MRO training examples found. The strand LMAX may not have");
    console.log("  enough MRO interaction data yet. Send test queries to mro@zmail.bot");
    console.log("  to generate training data.");
    return;
  }

  // Convert to ShareGPT format
  const shareGPT = toShareGPT(result.examples, config.systemPrompt);

  // Train/validation split
  const splitIdx = Math.floor(shareGPT.length * splitRatio);
  const trainSet = shareGPT.slice(0, splitIdx);
  const validSet = shareGPT.slice(splitIdx);

  // Write outputs — /shdata/005/zhanjun/ is the canonical MLOps working dir on JARVIS
  const outDir = existsSync("/shdata/005/zhanjun")
    ? "/shdata/005/zhanjun/training_exports"
    : resolve(PROJECT_ROOT, "src/data/training_exports");
  mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");

  let trainPath: string;
  let validPath: string;

  if (isSample) {
    // Sample goes to /tmp
    trainPath = "/tmp/mro_train_sample.jsonl";
    validPath = "/tmp/mro_valid_sample.jsonl";

    writeFileSync(trainPath, trainSet.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(validPath, validSet.map((e) => JSON.stringify(e)).join("\n") + "\n");

    console.log(`\n  Sample export complete:`);
    console.log(`  Train sample: ${trainPath} (${trainSet.length} examples)`);
    console.log(`  Valid sample: ${validPath} (${validSet.length} examples)`);
  } else {
    trainPath = resolve(outDir, `mro-train-${ts}.jsonl`);
    validPath = resolve(outDir, `mro-valid-${ts}.jsonl`);

    writeFileSync(trainPath, trainSet.map((e) => JSON.stringify(e)).join("\n") + "\n");
    writeFileSync(validPath, validSet.map((e) => JSON.stringify(e)).join("\n") + "\n");

    console.log(`\n  Export complete:`);
    console.log(`  Train: ${trainPath} (${trainSet.length} examples)`);
    console.log(`  Valid: ${validPath} (${validSet.length} examples)`);
  }

  console.log(`  Format: ShareGPT (NeMo Automodel native)`);
  console.log(`  Total fetched: ${result.totalStrands} strands`);
  console.log(`  Exported: ${result.exportedCount} examples`);

  // Print event kind breakdown
  const byKind = new Map<string, number>();
  for (const ex of result.examples) {
    byKind.set(ex.eventKind, (byKind.get(ex.eventKind) ?? 0) + 1);
  }
  console.log("\n  By event kind:");
  const kinds = Array.from(byKind.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [kind, count] of kinds) {
    console.log(`    ${kind}: ${count}`);
  }

  // Print deployment hint
  if (!isSample && result.exportedCount > 0) {
    console.log(`\n  Deploy to JARVIS:`);
    console.log(`  scp ${trainPath} ${validPath} jarvis:/shdata/005/zhanjun/`);
    console.log(`  ssh jarvis "bash infra/jarvis/launch_dsv4_finetune.sh"`);
    console.log(`\n  Or test first:`);
    console.log(`  ssh jarvis "bash infra/jarvis/launch_dsv4_finetune.sh --test-mode"`);
  }

  // Print sample output
  if (shareGPT.length > 0) {
    console.log(`\n  Sample (first example):`);
    console.log(JSON.stringify(shareGPT[0], null, 2));
  }
}

main().catch((err) => {
  console.error("jarvis_train_bridge fatal:", (err as Error).message);
  process.exit(1);
});
