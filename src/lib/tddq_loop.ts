// tddq_loop.ts — Training-Data-Driven-Query loop (Innovation 1a).
//
// Validates expert replies against ground truth and prepares injection
// samples for the training pipeline. This is the training-time counterpart
// to inference_hallucination_guard.ts (innovation 1c).
//
// Used by routes_flywheel.ts TDDQ endpoints:
//   POST /api/v1/tddq/detect  — detection (via training_uncertainty.ts)
//   POST /api/v1/tddq/validate — validation + injection prep (this module)

import type { DomainKind } from "./training_uncertainty";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TddqReply {
  message_id: string;
  from_pubkey_hex: string;
  body_text: string;
  evidence_urls: string[];
  signature_valid: boolean;
}

export interface ValidatedReply {
  message_id: string;
  from_pubkey_hex: string;
  body_text: string;
  evidence_urls: string[];
  accepted: boolean;
  failure_reason?: string;
  confidence: number;
}

export interface InjectionSample {
  query: string;
  expected_answer: string;
  evidence_urls: string[];
  domain: DomainKind;
  difficulty: "easy" | "medium" | "hard";
  source_message_id: string;
  source_pubkey_hex: string;
  injected_at: number;
}

// ─── Validation ─────────────────────────────────────────────────────────────

export function validateReplies(
  replies: TddqReply[],
  domain: DomainKind,
): ValidatedReply[] {
  return replies.map((r) => {
    const failures: string[] = [];

    if (!r.signature_valid) {
      failures.push("invalid signature");
    }
    if (!r.body_text || r.body_text.trim().length < 10) {
      failures.push("reply body too short");
    }
    if (r.evidence_urls.length === 0) {
      failures.push("no evidence URLs provided");
    }

    const accepted = failures.length === 0;

    return {
      message_id: r.message_id,
      from_pubkey_hex: r.from_pubkey_hex,
      body_text: r.body_text,
      evidence_urls: r.evidence_urls,
      accepted,
      failure_reason: failures.length > 0 ? failures.join("; ") : undefined,
      confidence: accepted ? 0.8 : 0.2,
    };
  });
}

// ─── Injection preparation ──────────────────────────────────────────────────

export function prepareInjection(
  accepted: ValidatedReply[],
  context: string,
): InjectionSample[] {
  return accepted.map((r) => ({
    query: context || `TDDQ reply ${r.message_id.slice(0, 8)}`,
    expected_answer: r.body_text.slice(0, 2000),
    evidence_urls: r.evidence_urls,
    domain: "mro" as DomainKind,
    difficulty: "medium" as const,
    source_message_id: r.message_id,
    source_pubkey_hex: r.from_pubkey_hex,
    injected_at: Date.now(),
  }));
}
