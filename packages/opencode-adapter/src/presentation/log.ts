import type {
  BuiltInReviewResult,
  ReviewLevelResult,
  ReviewOutcome,
  ReviewResult,
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

function ruleLogResult(result: RuleReviewResult): ReviewLogResult {
  const identity = {
    kind: "RULE" as const,
    ruleId: result.ruleId,
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
