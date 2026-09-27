import { describe, expect, test } from "vitest";
import { aggregateReviewHistory } from "../src/index";
import type {
  ReportRecord,
  ReportResult,
  RuleEvidenceMetadata,
  SemanticVerdict,
  SkippedReason,
  UnavailableReason,
} from "../src/index";

function emptySummary(): ReportRecord["summary"] {
  return {
    highestVerdict: null,
    hasUnavailable: false,
    counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
  };
}

function record(timestamp: string, results: readonly ReportResult[]): ReportRecord {
  return { timestamp, turnId: `turn-${timestamp}`, summary: emptySummary(), results };
}

function ruleSemantic(ruleId: string, outcome: SemanticVerdict, probability = 0.1): ReportResult {
  return { kind: "RULE", ruleId, outcome, violationProbability: probability };
}

function ruleOperational(
  ruleId: string | null,
  reason: SkippedReason | UnavailableReason,
): ReportResult {
  return reason === "NO_SCOPE_MATCH" || reason === "NO_ATTRIBUTED_PATCH"
    ? { kind: "RULE", ruleId, outcome: "SKIPPED", reason }
    : { kind: "RULE", ruleId, outcome: "UNAVAILABLE", reason };
}

function builtIn(checkId: string, outcome: SemanticVerdict, probability = 0.1): ReportResult {
  return { kind: "BUILT_IN", checkId, outcome, violationProbability: probability };
}

function slicedEvidence(
  judgments: readonly { probability: number; outcome: SemanticVerdict }[],
): RuleEvidenceMetadata {
  return {
    mode: "SLICED",
    plannedSliceCount: judgments.length,
    evaluatedSliceCount: judgments.length,
    failedSliceCount: 0,
    notEvaluatedSliceCount: 0,
    slices: judgments.map((_judgment, index) => ({
      index,
      path: `file-${index}.ts`,
      kind: "FILE",
      hunkOrdinal: null,
    })),
    sliceJudgments: judgments.map((judgment, index) => ({
      index,
      probability: judgment.probability,
      outcome: judgment.outcome,
    })),
    failingSliceIndex: null,
    failureReason: null,
  };
}

function ruleSliced(
  ruleId: string,
  judgments: readonly { probability: number; outcome: SemanticVerdict }[],
): ReportResult {
  return {
    kind: "RULE",
    ruleId,
    outcome: "PASS",
    violationProbability: 0.2,
    evidence: slicedEvidence(judgments),
  };
}

function ruleWhole(ruleId: string, probability = 0.1): ReportResult {
  return {
    kind: "RULE",
    ruleId,
    outcome: "PASS",
    violationProbability: probability,
    evidence: {
      mode: "WHOLE",
      plannedSliceCount: 1,
      evaluatedSliceCount: 1,
      failedSliceCount: 0,
      notEvaluatedSliceCount: 0,
      slices: [{ index: 0, path: null, kind: "WHOLE", hunkOrdinal: null }],
      sliceJudgments: [{ index: 0, probability, outcome: "PASS" }],
      failingSliceIndex: null,
      failureReason: null,
    },
  };
}

describe("aggregateReviewHistory totals and reasons", () => {
  test("counts every outcome across every record with a total", () => {
    const report = aggregateReviewHistory(
      [
        record("2026-01-01T00:00:00.000Z", [
          ruleSemantic("R-1", "PASS"),
          ruleSemantic("R-2", "WARN", 0.5),
          ruleSemantic("R-3", "FAIL", 0.9),
        ]),
        record("2026-01-02T00:00:00.000Z", [
          ruleOperational("R-4", "JEV_FAILURE"),
          ruleOperational("R-5", "NO_SCOPE_MATCH"),
        ]),
      ],
      0,
    );

    expect(report.outcomes).toEqual({
      pass: 1,
      warn: 1,
      fail: 1,
      unavailable: 1,
      skipped: 1,
      total: 5,
    });
  });

  test("breaks UNAVAILABLE and SKIPPED down by typed reason in code order", () => {
    const report = aggregateReviewHistory(
      [
        record("2026-01-01T00:00:00.000Z", [
          ruleOperational("R-1", "JEV_FAILURE"),
          ruleOperational("R-2", "BLOCKED_EVIDENCE"),
          ruleOperational("R-3", "JEV_FAILURE"),
          ruleOperational("R-4", "NO_SCOPE_MATCH"),
          ruleOperational("R-5", "NO_ATTRIBUTED_PATCH"),
          ruleOperational("R-6", "NO_SCOPE_MATCH"),
        ]),
      ],
      0,
    );

    expect(report.unavailableReasons).toEqual([
      { reason: "BLOCKED_EVIDENCE", count: 1 },
      { reason: "JEV_FAILURE", count: 2 },
    ]);
    expect(report.skippedReasons).toEqual([
      { reason: "NO_ATTRIBUTED_PATCH", count: 1 },
      { reason: "NO_SCOPE_MATCH", count: 2 },
    ]);
  });

  test("counts built-in results by check ID in ID order", () => {
    const report = aggregateReviewHistory(
      [
        record("2026-01-01T00:00:00.000Z", [
          builtIn("SCOPE-CREEP", "PASS"),
          builtIn("COMPLEXITY", "WARN", 0.6),
          builtIn("SCOPE-CREEP", "FAIL", 0.9),
        ]),
      ],
      0,
    );

    expect(report.builtIns).toEqual([
      { checkId: "COMPLEXITY", count: 1 },
      { checkId: "SCOPE-CREEP", count: 2 },
    ]);
  });

  test("breaks rules down by rule ID with per-outcome counts and sliced evaluations", () => {
    const report = aggregateReviewHistory(
      [
        record("2026-01-01T00:00:00.000Z", [
          ruleSemantic("R-B", "PASS"),
          ruleOperational("R-A", "NO_SCOPE_MATCH"),
          ruleSliced("R-A", [
            { probability: 0.1, outcome: "PASS" },
            { probability: 0.2, outcome: "PASS" },
          ]),
          ruleOperational(null, "NO_SCOPE_MATCH"),
          ruleSemantic("R-B", "FAIL", 0.9),
        ]),
      ],
      0,
    );

    expect(report.rules).toEqual([
      {
        ruleId: "R-A",
        counts: { pass: 1, warn: 0, fail: 0, unavailable: 0, skipped: 1, total: 2 },
        slicedRuleCount: 1,
      },
      {
        ruleId: "R-B",
        counts: { pass: 1, warn: 0, fail: 1, unavailable: 0, skipped: 0, total: 2 },
        slicedRuleCount: 0,
      },
    ]);
  });

  test("counts whole versus sliced evaluations and total slice judgments", () => {
    const report = aggregateReviewHistory(
      [
        record("2026-01-01T00:00:00.000Z", [
          ruleWhole("R-1"),
          ruleSliced("R-2", [
            { probability: 0.1, outcome: "PASS" },
            { probability: 0.2, outcome: "WARN" },
          ]),
          ruleSliced("R-3", [{ probability: 0.1, outcome: "PASS" }]),
        ]),
      ],
      0,
    );

    expect(report.evaluation).toEqual({
      wholeEvaluations: 1,
      slicedEvaluations: 2,
      totalSliceJudgments: 3,
    });
  });

  test("reports entry count, malformed-line count, and timestamp bounds", () => {
    const report = aggregateReviewHistory(
      [
        record("2026-02-01T00:00:00.000Z", [ruleSemantic("R-1", "PASS")]),
        record("2026-01-01T00:00:00.000Z", [ruleSemantic("R-2", "PASS")]),
        record("2026-03-01T00:00:00.000Z", [ruleSemantic("R-3", "PASS")]),
      ],
      4,
    );

    expect(report.entryCount).toBe(3);
    expect(report.skippedLineCount).toBe(4);
    expect(report.firstTimestamp).toBe("2026-01-01T00:00:00.000Z");
    expect(report.lastTimestamp).toBe("2026-03-01T00:00:00.000Z");
  });
});

describe("aggregateReviewHistory determinism and empty input", () => {
  test("produces the same report regardless of source order", () => {
    const ascending = aggregateReviewHistory(
      [
        record("2026-01-01T00:00:00.000Z", [
          ruleSemantic("A", "PASS"),
          ruleOperational("B", "JEV_FAILURE"),
          builtIn("SCOPE-CREEP", "PASS"),
        ]),
      ],
      0,
    );
    const descending = aggregateReviewHistory(
      [
        record("2026-01-01T00:00:00.000Z", [
          builtIn("SCOPE-CREEP", "PASS"),
          ruleOperational("B", "JEV_FAILURE"),
          ruleSemantic("A", "PASS"),
        ]),
      ],
      0,
    );

    expect(JSON.stringify(ascending)).toBe(JSON.stringify(descending));
  });

  test("returns an empty report for no records", () => {
    const report = aggregateReviewHistory([], 2);

    expect(report).toEqual({
      entryCount: 0,
      skippedLineCount: 2,
      firstTimestamp: null,
      lastTimestamp: null,
      outcomes: { pass: 0, warn: 0, fail: 0, unavailable: 0, skipped: 0, total: 0 },
      unavailableReasons: [],
      skippedReasons: [],
      builtIns: [],
      rules: [],
      evaluation: { wholeEvaluations: 0, slicedEvaluations: 0, totalSliceJudgments: 0 },
    });
  });
});
