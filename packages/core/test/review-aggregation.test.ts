import { describe, expect, test } from "vitest";
import { aggregateReview } from "../src/index";
import type { RuleReviewResult, SkippedReason, UnavailableReason } from "../src/index";

function semantic(
  outcome: "PASS" | "WARN" | "FAIL",
  probability: number,
  ruleId: string,
): RuleReviewResult {
  return {
    turnId: "turn-1",
    ruleId,
    severity: "error",
    scopedPaths: [],
    outcome,
    violationProbability: probability,
  };
}

function skipped(ruleId: string, reason: SkippedReason): RuleReviewResult {
  return {
    turnId: "turn-1",
    ruleId,
    severity: "error",
    scopedPaths: [],
    outcome: "SKIPPED",
    reason,
  };
}

function unavailable(ruleId: string | null, reason: UnavailableReason): RuleReviewResult {
  return {
    turnId: "turn-1",
    ruleId,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

describe("aggregateReview", () => {
  test("counts every outcome and preserves source order", () => {
    const results: readonly RuleReviewResult[] = [
      semantic("PASS", 0.1, "R-PASS"),
      unavailable("R-UNAVAILABLE", "JEV_FAILURE"),
      semantic("FAIL", 0.9, "R-FAIL"),
      skipped("R-SKIPPED", "NO_SCOPE_MATCH"),
      semantic("WARN", 0.5, "R-WARN"),
    ];

    const review = aggregateReview("turn-1", results);

    expect(review.turnId).toBe("turn-1");
    expect(review.results).toEqual(results);
    expect(review.summary.verdict).toBe("FAIL");
    expect(review.summary.hasUnavailable).toBe(true);
    expect(review.summary.counts).toEqual({
      pass: 1,
      warn: 1,
      fail: 1,
      skipped: 1,
      unavailable: 1,
    });
  });

  test("ignores skipped and unavailable when choosing the highest verdict", () => {
    const review = aggregateReview("turn-1", [
      unavailable(null, "INVALID_RULE"),
      skipped("R-SKIPPED", "NO_SCOPE_MATCH"),
      semantic("WARN", 0.5, "R-WARN"),
      semantic("PASS", 0.1, "R-PASS"),
    ]);

    expect(review.summary.verdict).toBe("WARN");
    expect(review.summary.hasUnavailable).toBe(true);
    expect(review.summary.counts).toEqual({
      pass: 1,
      warn: 1,
      fail: 0,
      skipped: 1,
      unavailable: 1,
    });
  });

  test("returns no verdict when no rule reached a semantic outcome", () => {
    const review = aggregateReview("turn-1", [
      unavailable(null, "INVALID_RULE"),
      skipped("R-SKIPPED", "NO_ATTRIBUTED_PATCH"),
    ]);

    expect(review.summary.verdict).toBeNull();
    expect(review.summary.hasUnavailable).toBe(true);
  });

  test("reports an empty review without verdict or unavailable", () => {
    const review = aggregateReview("turn-1", []);

    expect(review.summary).toEqual({
      verdict: null,
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
    });
  });

  test("snapshots the source results against later mutation", () => {
    const source: RuleReviewResult[] = [semantic("PASS", 0.1, "R-1")];

    const review = aggregateReview("turn-1", source);

    source.push(semantic("FAIL", 0.9, "R-2"));
    source[0] = semantic("FAIL", 0.9, "R-1");

    expect(review.results).toEqual([semantic("PASS", 0.1, "R-1")]);
    expect(review.summary.verdict).toBe("PASS");
    expect(review.summary.counts).toEqual({
      pass: 1,
      warn: 0,
      fail: 0,
      skipped: 0,
      unavailable: 0,
    });
  });
});
