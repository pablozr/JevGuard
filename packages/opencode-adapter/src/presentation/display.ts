import type { ReviewCounts, ReviewOutcome } from "@jevguard/core";

/**
 * Display outcome for one aggregate review, using the precedence
 * `FAIL > UNAVAILABLE > WARN > PASS > SKIPPED`. Counts drive the choice because
 * the aggregate summary counts every result, so a skipped-only turn resolves to
 * `SKIPPED` rather than to a semantic verdict.
 */
export function displayOutcome(counts: ReviewCounts): ReviewOutcome {
  if (counts.fail > 0) {
    return "FAIL";
  }

  if (counts.unavailable > 0) {
    return "UNAVAILABLE";
  }

  if (counts.warn > 0) {
    return "WARN";
  }

  if (counts.pass > 0) {
    return "PASS";
  }

  return "SKIPPED";
}
