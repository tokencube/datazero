// flywheel_retrain_trigger.ts — Automatic QLoRA retraining decisions.
//
// Monitors 3 signals and decides when to trigger a new training run:
//   1. Self-play failure rate   (from selfplay_store)
//   2. Active learning queue depth (from active_learning_queue)
//   3. Quality gate status       (from mro_quality_gate)
//
// Used by:
//   - POST /api/v1/flywheel/retrain/check  (routes_flywheel.ts)
//   - mro_quality_gate.ts (6th dimension: self-play health)
//   - mro_selfplay_daemon.ts (auto-trigger on high failure rate)

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetrainSignal {
  selfplay_failure_rate: number;
  selfplay_total_rounds: number;
  active_learning_queue_depth: number;
  quality_gate_status: "healthy" | "degraded" | "critical";
  quality_score: number;
}

export interface RetrainDecision {
  trigger: boolean;
  reason: string;
  priority: "low" | "medium" | "high";
  signals: RetrainSignal;
  recommended_config?: {
    lora_rank: number;
    epochs: number;
    dataset_filter: string;
    model: string;
  };
}

export interface TrainingCorpus {
  queries: Array<{
    query: string;
    expected_sku: string;
    domain: string;
    difficulty: "easy" | "medium" | "hard";
    source: "selfplay" | "active_learning" | "golden_eval";
  }>;
  total_samples: number;
  source_breakdown: Record<string, number>;
}

// ─── Thresholds ─────────────────────────────────────────────────────────────

const THRESHOLDS = {
  /** Self-play failure rate that triggers retraining. */
  failure_rate_high: 0.50,
  failure_rate_medium: 0.30,
  failure_rate_low: 0.15,
  /** Active learning queue depth triggers. */
  queue_depth_high: 200,
  queue_depth_medium: 100,
  queue_depth_low: 50,
  /** Minimum rounds before trusting self-play stats. */
  min_selfplay_rounds: 50,
};

// ─── Decision logic ─────────────────────────────────────────────────────────

export function shouldTriggerRetraining(signals: RetrainSignal): RetrainDecision {
  let trigger = false;
  let reason = "";
  let priority: RetrainDecision["priority"] = "low";

  // Primary signal: self-play failure rate
  if (
    signals.selfplay_total_rounds >= THRESHOLDS.min_selfplay_rounds &&
    signals.selfplay_failure_rate > THRESHOLDS.failure_rate_high
  ) {
    trigger = true;
    reason = `self-play failure rate critical: ${(signals.selfplay_failure_rate * 100).toFixed(0)}% (threshold: ${(THRESHOLDS.failure_rate_high * 100).toFixed(0)}%)`;
    priority = "high";
  } else if (
    signals.selfplay_total_rounds >= THRESHOLDS.min_selfplay_rounds &&
    signals.selfplay_failure_rate > THRESHOLDS.failure_rate_medium
  ) {
    trigger = true;
    reason = `self-play failure rate elevated: ${(signals.selfplay_failure_rate * 100).toFixed(0)}%`;
    priority = "medium";
  }

  // Secondary signal: quality gate degradation
  if (!trigger && signals.quality_gate_status === "critical") {
    trigger = true;
    reason = `quality gate critical (score: ${signals.quality_score})`;
    priority = "high";
  } else if (!trigger && signals.quality_gate_status === "degraded") {
    trigger = true;
    reason = `quality gate degraded (score: ${signals.quality_score})`;
    priority = "medium";
  }

  // Tertiary signal: active learning queue pressure
  if (!trigger && signals.active_learning_queue_depth > THRESHOLDS.queue_depth_high) {
    trigger = true;
    reason = `active learning queue backlog: ${signals.active_learning_queue_depth} pending (threshold: ${THRESHOLDS.queue_depth_high})`;
    priority = "medium";
  } else if (!trigger && signals.active_learning_queue_depth > THRESHOLDS.queue_depth_medium) {
    trigger = true;
    reason = `active learning queue growing: ${signals.active_learning_queue_depth} pending`;
    priority = "low";
  }

  if (!trigger) {
    reason = "all signals within normal range";
  }

  // Recommend training config based on signal profile
  let recommendedConfig: RetrainDecision["recommended_config"] | undefined;
  if (trigger) {
    if (priority === "high") {
      recommendedConfig = {
        lora_rank: 64,
        epochs: 5,
        dataset_filter: "selfplay_failures+active_learning+golden_errors",
        model: "qwen3.5-9b",
      };
    } else if (priority === "medium") {
      recommendedConfig = {
        lora_rank: 32,
        epochs: 3,
        dataset_filter: "selfplay_failures+active_learning",
        model: "qwen3.5-9b",
      };
    } else {
      recommendedConfig = {
        lora_rank: 16,
        epochs: 2,
        dataset_filter: "selfplay_failures",
        model: "qwen3.5-9b",
      };
    }
  }

  return {
    trigger,
    reason,
    priority,
    signals,
    recommended_config: recommendedConfig,
  };
}

// ─── Training corpus collection ─────────────────────────────────────────────

export async function collectTrainingCorpus(
  sources: {
    selfplayFailures?: Array<{ query: string; expected_sku: string; strategy: string }>;
    activeLearning?: Array<{ query: string; expected_sku: string }>;
    goldenEvalErrors?: Array<{ query: string; expected_sku: string }>;
  },
): Promise<TrainingCorpus> {
  const queries: TrainingCorpus["queries"] = [];
  const sourceBreakdown: Record<string, number> = {};

  if (sources.selfplayFailures) {
    for (const f of sources.selfplayFailures) {
      queries.push({
        query: f.query,
        expected_sku: f.expected_sku,
        domain: "mro",
        difficulty: f.strategy === "spelling_error" || f.strategy === "cross_language" ? "hard" : "medium",
        source: "selfplay",
      });
    }
    sourceBreakdown.selfplay = sources.selfplayFailures.length;
  }

  if (sources.activeLearning) {
    for (const a of sources.activeLearning) {
      queries.push({
        query: a.query,
        expected_sku: a.expected_sku,
        domain: "mro",
        difficulty: "medium",
        source: "active_learning",
      });
    }
    sourceBreakdown.active_learning = sources.activeLearning.length;
  }

  if (sources.goldenEvalErrors) {
    for (const g of sources.goldenEvalErrors) {
      queries.push({
        query: g.query,
        expected_sku: g.expected_sku,
        domain: "mro",
        difficulty: "hard",
        source: "golden_eval",
      });
    }
    sourceBreakdown.golden_eval = sources.goldenEvalErrors.length;
  }

  return {
    queries,
    total_samples: queries.length,
    source_breakdown: sourceBreakdown,
  };
}

// ─── JARVIS training trigger ────────────────────────────────────────────────

export async function triggerRetraining(
  config: NonNullable<RetrainDecision["recommended_config"]>,
  jarvisBridgeUrl = "https://3.zmail.bot/bridge",
): Promise<{ run_id: string; status: string } | { error: string }> {
  try {
    const res = await fetch(`${jarvisBridgeUrl}/train/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        config_name: `auto_retrain_${Date.now()}`,
        model: config.model,
        lora_rank: config.lora_rank,
        epochs: config.epochs,
        dataset_filter: config.dataset_filter,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return { error: `JARVIS bridge returned ${res.status}` };
    }

    const data = (await res.json()) as { run_id: string; ok: boolean; error?: string };
    if (!data.ok) {
      return { error: data.error || "launch failed" };
    }

    return { run_id: data.run_id, status: "started" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
