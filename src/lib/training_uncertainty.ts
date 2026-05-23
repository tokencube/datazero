// training_uncertainty.ts — Knowledge gap detection & uncertainty scoring.
//
// Shared by:
//   - inference_hallucination_guard.ts (innovation 1c)
//   - routes_flywheel.ts (TDDQ loop API)
//
// Detects domain-specific knowledge gaps in model outputs and generates
// targeted training queries to close those gaps.

// ─── Domain types ───────────────────────────────────────────────────────────

export type DomainKind = "av" | "cloud_control" | "mower_vla" | "mro";

export interface DomainWeights {
  av: number;
  cloud_control: number;
  mower_vla: number;
  mro: number;
}

export const DOMAIN_WEIGHTS: DomainWeights = {
  av: 1.0,
  cloud_control: 0.8,
  mower_vla: 0.9,
  mro: 0.7,
};

// ─── Knowledge gap detection ────────────────────────────────────────────────

export interface GapDetectionInput {
  currentPpl: number;
  baselinePpl: number;
  gradientNorms: number[];
  topConfidence: number;
  domain: DomainKind;
  informationValue?: number;
  queryCost?: number;
}

export interface GapDetection {
  should_query: boolean;
  domain: DomainKind;
  ppl_delta: number;
  confidence_gap: number;
  gradient_instability: number;
  information_value: number;
  reason: string;
}

export function detectKnowledgeGap(input: GapDetectionInput): GapDetection {
  const pplDelta = input.currentPpl - input.baselinePpl;
  const avgGradientNorm =
    input.gradientNorms.length > 0
      ? input.gradientNorms.reduce((a, b) => a + b, 0) / input.gradientNorms.length
      : 0;
  const confidenceGap = 1.0 - input.topConfidence;
  const iv = input.informationValue ?? confidenceGap * pplDelta;

  // Trigger when: perplexity rising AND confidence dropping AND gradients unstable
  const shouldQuery =
    pplDelta > 0.05 || confidenceGap > 0.3 || avgGradientNorm > 1.5;

  let reason = "";
  if (pplDelta > 0.1) reason = `PPL drift +${pplDelta.toFixed(3)}`;
  else if (confidenceGap > 0.3) reason = `low confidence (${input.topConfidence.toFixed(2)})`;
  else if (avgGradientNorm > 1.5) reason = `gradient instability (${avgGradientNorm.toFixed(2)})`;
  else reason = "no gap detected";

  return {
    should_query: shouldQuery,
    domain: input.domain,
    ppl_delta: pplDelta,
    confidence_gap: confidenceGap,
    gradient_instability: avgGradientNorm,
    information_value: iv,
    reason,
  };
}

// ─── Gap query generation ───────────────────────────────────────────────────

export interface GapQueryParams {
  modelName: string;
  trainingStep: number;
  tokenContext: string;
}

export interface GapQuery {
  query_text: string;
  domain: DomainKind;
  target_concept: string;
  difficulty: "easy" | "medium" | "hard";
  expected_answer_format: string;
  model_name: string;
  training_step: number;
}

export function generateGapQuery(
  detection: GapDetection,
  params: GapQueryParams,
): GapQuery {
  const domainQueries: Record<DomainKind, string[]> = {
    av: [
      "What is the steering angle when a vehicle merges in heavy rain?",
      "How does the ego vehicle handle a pedestrian jaywalking at night?",
      "What is the safe following distance on a wet road at 60 km/h?",
    ],
    cloud_control: [
      "What is the root cause of a motor torque anomaly at 1500 RPM?",
      "How to diagnose an intermittent sensor failure on conveyor belt #3?",
      "What PLC fault codes indicate a bearing wear in a 3-phase induction motor?",
    ],
    mower_vla: [
      "What are the Bekker parameters for Kentucky Bluegrass on a 15° slope after rain?",
      "How does wet grass affect the mower's steering angle at 0.5 m/s?",
      "What is the optimal blade RPM for Bermuda grass at 3cm height?",
    ],
    mro: [
      "What is the cross-reference for SKF bearing 6205-2RS in Chinese market?",
      "Identify the OEM part number for a Festo pneumatic cylinder with bore 32mm stroke 100mm",
      "What is the hydraulic oil equivalent for Shell Tellus S2 MX 46 available in Asia?",
    ],
  };

  const pool = domainQueries[detection.domain];
  const idx = params.trainingStep % pool.length;
  const difficulty: GapQuery["difficulty"] =
    detection.confidence_gap > 0.5 ? "hard" : detection.confidence_gap > 0.3 ? "medium" : "easy";

  return {
    query_text: pool[idx],
    domain: detection.domain,
    target_concept: `${detection.domain}_gap_${params.trainingStep}`,
    difficulty,
    expected_answer_format: "text",
    model_name: params.modelName,
    training_step: params.trainingStep,
  };
}
