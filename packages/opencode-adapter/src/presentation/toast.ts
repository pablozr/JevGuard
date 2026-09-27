import type { ReviewCounts, ReviewOutcome, ReviewResult, TurnReview } from "@jevguard/core";
import { displayOutcome } from "./display";
import type { ReviewToast, ToastVariant } from "./types";

export function toReviewToast(review: TurnReview): ReviewToast {
  const outcome = displayOutcome(review.summary.counts);

  return {
    title: `JevGuard ${outcome}`,
    message: `${countSummary(review.summary.counts)}${slicedSummary(review.results)}`,
    variant: toastVariantFor(outcome),
  };
}

/**
 * Appends the number of sliced rules and their evaluated slice judgments when either
 * is non-zero. The suffix carries counts only, never probabilities, paths, or diff.
 */
function slicedSummary(results: readonly ReviewResult[]): string {
  let slicedRules = 0;
  let sliceJudgments = 0;

  for (const result of results) {
    if (result.kind !== "RULE" || result.evidence === undefined) {
      continue;
    }

    if (result.evidence.mode !== "SLICED") {
      continue;
    }

    slicedRules += 1;
    sliceJudgments += result.evidence.evaluatedSliceCount;
  }

  if (slicedRules === 0 && sliceJudgments === 0) {
    return "";
  }

  return ` · sliced ${slicedRules} rules · slices ${sliceJudgments}`;
}

export function toastVariantFor(outcome: ReviewOutcome): ToastVariant {
  switch (outcome) {
    case "PASS":
      return "success";
    case "WARN":
      return "warning";
    case "FAIL":
    case "UNAVAILABLE":
      return "error";
    case "SKIPPED":
      return "info";
  }
}

/** Safe aggregate message: rule outcome counts only, never probabilities or paths. */
export function countSummary(counts: ReviewCounts): string {
  return `pass ${counts.pass} · warn ${counts.warn} · fail ${counts.fail} · skipped ${counts.skipped} · unavailable ${counts.unavailable}`;
}
