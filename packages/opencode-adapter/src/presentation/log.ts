import type { ReviewOutcome, RuleReviewResult, TurnReview } from "@jevguard/core";
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

export function toReviewLogResult(result: RuleReviewResult): ReviewLogResult {
  const context = {
    ruleId: result.ruleId,
    severity: result.severity,
    scopedPaths: [...result.scopedPaths],
  };

  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return {
        ...context,
        outcome: result.outcome,
        violationProbability: result.violationProbability,
      };
    case "SKIPPED":
    case "UNAVAILABLE":
      return { ...context, outcome: result.outcome, reason: result.reason };
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
