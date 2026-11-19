import { describe, expect, it } from "vitest";
import { confusionOf, costOf, summarizeLatency, summarizeRule } from "../metrics";
import type { CaseObservation } from "../types";

function observation(
  overrides: Partial<CaseObservation> & Pick<CaseObservation, "expected" | "observed">,
): CaseObservation {
  return {
    caseId: overrides.caseId ?? "case",
    ruleId: overrides.ruleId ?? "RULE-001",
    expected: overrides.expected,
    observed: overrides.observed,
    probability: overrides.probability ?? null,
    reason: overrides.reason ?? null,
    latencyMs: overrides.latencyMs ?? 100,
    inputTokens: overrides.inputTokens ?? 10,
    outputTokens: overrides.outputTokens ?? 1,
  };
}

describe("summarizeRule", () => {
  it("counts exact agreement, clean cases and the flagging mistakes", () => {
    const observations = [
      observation({ expected: "PASS", observed: "PASS" }),
      observation({ expected: "PASS", observed: "WARN" }),
      observation({ expected: "PASS", observed: "FAIL" }),
      observation({ expected: "FAIL", observed: "PASS" }),
      observation({ expected: "FAIL", observed: "FAIL" }),
      observation({ expected: "WARN", observed: "PASS" }),
      observation({ expected: "WARN", observed: "FAIL" }),
      observation({ expected: "PASS", observed: "UNAVAILABLE" }),
    ];

    const summary = summarizeRule({ id: "RULE-001", severity: "error" }, observations);

    expect(summary.cases).toBe(8);
    expect(summary.cleanCases).toBe(4);
    expect(summary.evaluated).toBe(7);
    expect(summary.unavailable).toBe(1);
    expect(summary.exact).toBe(2);
    expect(summary.confusion).toEqual({
      falseAlarm: 2,
      hardFalsePositive: 1,
      falseNegative: 1,
      missedWarning: 1,
      overFire: 1,
    });
  });

  it("never treats an unavailable case as a pass", () => {
    const confusion = confusionOf([observation({ expected: "PASS", observed: "UNAVAILABLE" })]);

    expect(confusion.falseAlarm).toBe(0);
    expect(confusion.hardFalsePositive).toBe(0);
  });
});

describe("summarizeLatency", () => {
  it("uses nearest-rank quantiles over the measured sample", () => {
    const summary = summarizeLatency([40, 10, 30, 20]);

    expect(summary.count).toBe(4);
    expect(summary.meanMs).toBe(25);
    expect(summary.p50Ms).toBe(20);
    expect(summary.p90Ms).toBe(40);
    expect(summary.minMs).toBe(10);
    expect(summary.maxMs).toBe(40);
  });

  it("reports nulls without a sample", () => {
    expect(summarizeLatency([]).p50Ms).toBeNull();
  });
});

describe("costOf", () => {
  it("charges only the input tokens at the list price", () => {
    expect(costOf(1_000_000, 500_000, 0.042, 0)).toBeCloseTo(0.042, 6);
    expect(costOf(0, 0, 0.042, 0)).toBe(0);
  });
});
