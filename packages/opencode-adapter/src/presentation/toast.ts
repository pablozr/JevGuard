import type { ReviewCounts, ReviewOutcome, TurnReview } from "@jevguard/core";
import { displayOutcome } from "./display";
import type { ReviewToast, ToastVariant } from "./types";

export function toReviewToast(review: TurnReview): ReviewToast {
  const outcome = displayOutcome(review.summary.counts);

  return {
    title: `JevGuard ${outcome}`,
    message: countSummary(review.summary.counts),
    variant: toastVariantFor(outcome),
  };
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
