import type { ReviewResult, RuleEvidenceMetadata, TurnReview } from "@jevguard/core";
import type { ClaudeAcquisitionReason } from "../acquisition";
import type { ReviewFeedRecorded, ReviewFeedResult, ReviewFeedStarted } from "./types";

interface ResultIdentity {
  readonly lane: ReviewFeedResult["lane"];
  readonly id: string | null;
  readonly sliceCount: number | null;
}

function sliceCountOf(evidence: RuleEvidenceMetadata | undefined): number | null {
  return evidence?.mode === "SLICED" ? evidence.plannedSliceCount : null;
}

function identityOf(result: ReviewResult): ResultIdentity {
  switch (result.kind) {
    case "RULE":
      return { lane: "RULE", id: result.ruleId, sliceCount: sliceCountOf(result.evidence) };
    case "BUILT_IN":
      return { lane: "BUILT_IN", id: result.checkId, sliceCount: null };
    case "REVIEW":
      return { lane: "REVIEW", id: null, sliceCount: null };
  }
}

function toFeedResult(result: ReviewResult): ReviewFeedResult {
  const identity = identityOf(result);

  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return { ...identity, outcome: result.outcome, probability: result.violationProbability };
    case "SKIPPED":
    case "UNAVAILABLE":
      return { ...identity, outcome: result.outcome, reason: result.reason };
  }
}

export function toFeedStarted(turnId: string, at: string): ReviewFeedStarted {
  return { v: 1, kind: "STARTED", turnId, at };
}

/**
 * Projects a review onto the feed allowlist: ids, outcomes, probabilities, reasons and
 * counts. `proposal` is written only when true, so lines without a proposal are unchanged.
 */
export function toFeedRecorded(
  review: TurnReview,
  causes: readonly ClaudeAcquisitionReason[],
  at: string,
  proposal = false,
): ReviewFeedRecorded {
  return {
    v: 1,
    kind: "RECORDED",
    turnId: review.turnId,
    at,
    counts: { ...review.summary.counts },
    causes: [...causes],
    results: review.results.map(toFeedResult),
    ...(proposal ? { proposal: true as const } : {}),
  };
}
