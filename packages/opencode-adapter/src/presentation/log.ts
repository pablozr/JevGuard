import type {
  BuiltInReviewResult,
  ReviewLevelResult,
  ReviewOutcome,
  ReviewResult,
  RuleEvidenceMetadata,
  RuleReviewResult,
  TurnReview,
} from "@jevguard/core";
import { displayOutcome } from "./display";
import type { ReviewLogEntry, ReviewLogResult } from "./types";

export function toReviewLogEntry(review: TurnReview): ReviewLogEntry {
  return {
    turnId: review.turnId,
    summary: {
      highestVerdict: review.summary.verdict,
      hasUnavailable: review.summary.hasUnavailable,
      counts: { ...review.summary.counts },
    },
    results: review.results.map(toReviewLogResult),
  };
}

/**
 * Projects one result onto the exact log allowlist. The review-result union is
 * fully discriminated by `kind`, so the switch is exhaustive over every lane.
 */
export function toReviewLogResult(result: ReviewResult): ReviewLogResult {
  switch (result.kind) {
    case "RULE":
      return ruleLogResult(result);
    case "BUILT_IN":
      return builtInLogResult(result);
    case "REVIEW":
      return reviewLevelLogResult(result);
  }
}

export function logLevelFor(outcome: ReviewOutcome): "info" | "warn" | "error" {
  switch (outcome) {
    case "PASS":
    case "SKIPPED":
      return "info";
    case "WARN":
      return "warn";
    case "FAIL":
    case "UNAVAILABLE":
      return "error";
  }
}

export function reviewLogMessage(entry: ReviewLogEntry): string {
  return `JevGuard ${displayOutcome(entry.summary.counts)} for turn ${entry.turnId}`;
}

/**
 * Explicit allowlist projection of slice metadata: counts, ordered summaries, and
 * per-slice probabilities and outcomes only. It never passes through internal objects
 * and carries no diff content.
 */
function projectEvidence(evidence: RuleEvidenceMetadata): RuleEvidenceMetadata {
  return {
    mode: evidence.mode,
    plannedSliceCount: evidence.plannedSliceCount,
    evaluatedSliceCount: evidence.evaluatedSliceCount,
    failedSliceCount: evidence.failedSliceCount,
    notEvaluatedSliceCount: evidence.notEvaluatedSliceCount,
    slices: evidence.slices.map((slice) => ({
      index: slice.index,
      path: slice.path,
      kind: slice.kind,
      hunkOrdinal: slice.hunkOrdinal,
    })),
    sliceJudgments: evidence.sliceJudgments.map((judgment) => ({
      index: judgment.index,
      probability: judgment.probability,
      outcome: judgment.outcome,
    })),
    failingSliceIndex: evidence.failingSliceIndex,
    failureReason: evidence.failureReason,
  };
}

function ruleLogResult(result: RuleReviewResult): ReviewLogResult {
  const identity = {
    kind: "RULE" as const,
    ruleId: result.ruleId,
    severity: result.severity,
    scopedPaths: [...result.scopedPaths],
    ...(result.evidence === undefined ? {} : { evidence: projectEvidence(result.evidence) }),
  };

  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return {
        ...identity,
        outcome: result.outcome,
        violationProbability: result.violationProbability,
      };
    case "SKIPPED":
    case "UNAVAILABLE":
      return { ...identity, outcome: result.outcome, reason: result.reason };
  }
}

function builtInLogResult(result: BuiltInReviewResult): ReviewLogResult {
  const identity = {
    kind: "BUILT_IN" as const,
    checkId: result.checkId,
    severity: result.severity,
    scopedPaths: [...result.scopedPaths],
  };

  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return {
        ...identity,
        outcome: result.outcome,
        violationProbability: result.violationProbability,
      };
    case "SKIPPED":
    case "UNAVAILABLE":
      return { ...identity, outcome: result.outcome, reason: result.reason };
  }
}

function reviewLevelLogResult(result: ReviewLevelResult): ReviewLogResult {
  return { kind: "REVIEW", outcome: result.outcome, reason: result.reason };
}
