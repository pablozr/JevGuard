import type { ReviewOutcome, ReviewResult, SemanticVerdict } from "../domain/types";
import type { ReviewCounts, ReviewSummary, TurnReview } from "./types";

const VERDICT_RANK: Record<SemanticVerdict, number> = { PASS: 0, WARN: 1, FAIL: 2 };

/**
 * Aggregates rule, built-in, and review-level results into one turn review. The
 * input array is snapshotted so later mutation cannot change the returned review;
 * results keep their source order, and the summary counts every outcome and reports
 * the highest verdict `FAIL > WARN > PASS` while ignoring `SKIPPED` and `UNAVAILABLE`.
 */
export function aggregateReview(turnId: string, results: readonly ReviewResult[]): TurnReview {
  const snapshot = [...results];

  return { turnId, results: snapshot, summary: summarize(snapshot) };
}

function summarize(results: readonly ReviewResult[]): ReviewSummary {
  const counts = countOutcomes(results);

  return {
    verdict: highestVerdict(results),
    hasUnavailable: counts.unavailable > 0,
    counts,
  };
}

function countOutcomes(results: readonly ReviewResult[]): ReviewCounts {
  const counts = { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 };

  for (const result of results) {
    switch (result.outcome) {
      case "PASS":
        counts.pass += 1;
        break;
      case "WARN":
        counts.warn += 1;
        break;
      case "FAIL":
        counts.fail += 1;
        break;
      case "SKIPPED":
        counts.skipped += 1;
        break;
      case "UNAVAILABLE":
        counts.unavailable += 1;
        break;
    }
  }

  return counts;
}

function highestVerdict(results: readonly ReviewResult[]): SemanticVerdict | null {
  let highest: SemanticVerdict | null = null;

  for (const result of results) {
    if (!isSemanticVerdict(result.outcome)) {
      continue;
    }

    if (highest === null || VERDICT_RANK[result.outcome] > VERDICT_RANK[highest]) {
      highest = result.outcome;
    }
  }

  return highest;
}

function isSemanticVerdict(outcome: ReviewOutcome): outcome is SemanticVerdict {
  return outcome === "PASS" || outcome === "WARN" || outcome === "FAIL";
}
