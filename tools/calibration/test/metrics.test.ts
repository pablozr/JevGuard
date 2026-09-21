import {
  DEFAULT_EVIDENCE_POLICY,
  evaluateBuiltIns,
  type JevEvaluationPort,
  type JevEvaluationResult,
  type Turn,
} from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  buildDistribution,
  buildGateStateMatrix,
  buildHistogram,
  buildOperatingPoints,
  buildRepeats,
  buildThresholdSweep,
  computeConfusionMatrix,
  computeDerivedMetrics,
  computeThresholdRow,
  countOperational,
  quantile,
  summarize,
} from "../metrics";
import type {
  CalibrationCheckId,
  CalibrationLabel,
  CalibrationOutcome,
  CheckScoreSample,
} from "../types";

interface SampleParams {
  readonly authorLabel: CalibrationLabel;
  readonly probability: number | null;
  readonly outcome?: CalibrationOutcome;
  readonly repeat?: number;
  readonly check?: CalibrationCheckId;
  readonly fixtureId?: string;
}

function sample(params: SampleParams): CheckScoreSample {
  const outcome = params.outcome ?? (params.probability === null ? "UNAVAILABLE" : "PASS");

  return {
    fixtureId: params.fixtureId ?? "fixture",
    check: params.check ?? "scopeCreep",
    repeat: params.repeat ?? 0,
    category: "requested-direct",
    difficulty: "clear",
    authorLabel: params.authorLabel,
    outcome,
    probability: params.probability,
    reason: params.probability === null ? "JEV_FAILURE" : null,
  };
}

class FixedBatchPort implements JevEvaluationPort {
  constructor(
    private readonly scope: number,
    private readonly complexity: number,
  ) {}

  async evaluate(): Promise<JevEvaluationResult> {
    return {
      kind: "BUILT_IN_BATCH",
      status: "EVALUATED",
      answers: {
        scopeCreep: { status: "EVALUATED", noul: { violationProbability: this.scope } },
        complexity: { status: "EVALUATED", noul: { violationProbability: this.complexity } },
      },
    };
  }
}

async function gateOutcomes(scope: number, complexity: number): Promise<readonly string[]> {
  const turn: Turn = {
    id: "turn",
    task: "Apply the change.",
    files: [{ path: "src/a.ts", patch: "+const value = 1;" }],
  };
  const result = await evaluateBuiltIns(
    { turn, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
    { jev: new FixedBatchPort(scope, complexity) },
  );

  return [result.scopeCreep.outcome, result.complexity.outcome];
}

describe("confusion matrix boundaries", () => {
  const scopeSamples = [
    sample({ authorLabel: "VIOLATION", probability: 0.399 }),
    sample({ authorLabel: "VIOLATION", probability: 0.4 }),
    sample({ authorLabel: "VIOLATION", probability: 0.699 }),
    sample({ authorLabel: "VIOLATION", probability: 0.7 }),
    sample({ authorLabel: "NO_VIOLATION", probability: 0.399 }),
    sample({ authorLabel: "NO_VIOLATION", probability: 0.4 }),
  ];

  test("scope 0.40 counts WARN-or-FAIL as positive", () => {
    expect(computeConfusionMatrix(scopeSamples, 0.4)).toEqual({
      truePositive: 3,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
    });
  });

  test("scope 0.70 counts only FAIL as positive", () => {
    expect(computeConfusionMatrix(scopeSamples, 0.7)).toEqual({
      truePositive: 1,
      falsePositive: 0,
      trueNegative: 2,
      falseNegative: 3,
    });
  });

  test("complexity 0.50 is inclusive at the boundary", () => {
    const complexitySamples = [
      sample({ authorLabel: "VIOLATION", probability: 0.499, check: "complexity" }),
      sample({ authorLabel: "VIOLATION", probability: 0.5, check: "complexity" }),
      sample({ authorLabel: "NO_VIOLATION", probability: 0.499, check: "complexity" }),
      sample({ authorLabel: "NO_VIOLATION", probability: 0.5, check: "complexity" }),
    ];

    expect(computeConfusionMatrix(complexitySamples, 0.5)).toEqual({
      truePositive: 1,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
    });
  });

  test("surfaces every confusion cell for a mixed sample", () => {
    const mixed = [
      sample({ authorLabel: "VIOLATION", probability: 0.9 }),
      sample({ authorLabel: "NO_VIOLATION", probability: 0.9 }),
      sample({ authorLabel: "NO_VIOLATION", probability: 0.1 }),
      sample({ authorLabel: "VIOLATION", probability: 0.1 }),
    ];

    expect(computeConfusionMatrix(mixed, 0.5)).toEqual({
      truePositive: 1,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
    });
  });

  test("excludes unavailable samples from semantic denominators", () => {
    const withUnavailable = [
      sample({ authorLabel: "VIOLATION", probability: 0.9 }),
      sample({ authorLabel: "VIOLATION", probability: null }),
      sample({ authorLabel: "NO_VIOLATION", probability: null, outcome: "SKIPPED" }),
    ];

    expect(computeConfusionMatrix(withUnavailable, 0.5)).toEqual({
      truePositive: 1,
      falsePositive: 0,
      trueNegative: 0,
      falseNegative: 0,
    });
  });
});

describe("derived metrics", () => {
  test("returns null for every zero-denominator metric", () => {
    expect(
      computeDerivedMetrics({
        truePositive: 0,
        falsePositive: 0,
        trueNegative: 0,
        falseNegative: 0,
      }),
    ).toEqual({
      precision: null,
      recall: null,
      specificity: null,
      f1: null,
    });
  });

  test("returns null F1 when precision and recall are both zero", () => {
    const metrics = computeDerivedMetrics({
      truePositive: 0,
      falsePositive: 1,
      trueNegative: 1,
      falseNegative: 1,
    });

    expect(metrics.precision).toBe(0);
    expect(metrics.recall).toBe(0);
    expect(metrics.specificity).toBe(0.5);
    expect(metrics.f1).toBeNull();
  });

  test("computes F1 from precision and recall", () => {
    const metrics = computeDerivedMetrics({
      truePositive: 3,
      falsePositive: 1,
      trueNegative: 5,
      falseNegative: 1,
    });

    expect(metrics.precision).toBeCloseTo(0.75, 10);
    expect(metrics.recall).toBeCloseTo(0.75, 10);
    expect(metrics.f1).toBeCloseTo(0.75, 10);
  });
});

describe("quantiles and distributions", () => {
  test("interpolates linearly between closest ranks", () => {
    const values = [0, 1, 2, 3, 4];

    expect(quantile(values, 0.5)).toBe(2);
    expect(quantile(values, 0.25)).toBe(1);
    expect(quantile(values, 0.1)).toBeCloseTo(0.4, 10);
    expect(quantile(values, 0.9)).toBeCloseTo(3.6, 10);
  });

  test("summarizes the documented quantiles", () => {
    const summary = summarize([0, 1, 2, 3, 4]);

    expect(summary).not.toBeNull();
    expect(summary?.min).toBe(0);
    expect(summary?.max).toBe(4);
    expect(summary?.mean).toBe(2);
    expect(summary?.p50).toBe(2);
  });

  test("returns null for an empty sample", () => {
    expect(summarize([])).toBeNull();
  });

  test("places exactly 1.0 in the final histogram bin", () => {
    const histogram = buildHistogram([0, 0.05, 0.95, 1]);

    expect(histogram.counts[0]).toBe(2);
    expect(histogram.counts[9]).toBe(2);
    expect(histogram.bins[9]?.includesUpperBound).toBe(true);
    expect(histogram.counts.slice(1, 9).reduce((sum, value) => sum + value, 0)).toBe(0);
  });

  test("builds a distribution split by author label", () => {
    const distribution = buildDistribution([
      sample({ authorLabel: "VIOLATION", probability: 0.9 }),
      sample({ authorLabel: "VIOLATION", probability: 0.8 }),
      sample({ authorLabel: "NO_VIOLATION", probability: 0.1 }),
    ]);

    expect(distribution.overall?.count).toBe(3);
    expect(distribution.byAuthorLabel.violation?.count).toBe(2);
    expect(distribution.byAuthorLabel.noViolation?.count).toBe(1);
  });
});

describe("operating points and sweep", () => {
  test("uses the fixed scope and complexity operating points", () => {
    const scopePoints = buildOperatingPoints("scopeCreep", []);
    const complexityPoints = buildOperatingPoints("complexity", []);

    expect(scopePoints.map((point) => point.threshold)).toEqual([0.4, 0.7]);
    expect(complexityPoints.map((point) => point.threshold)).toEqual([0.5]);
  });

  test("sweeps 0.00 to 1.00 inclusive and de-duplicates operating points", () => {
    const rows = buildThresholdSweep([], [0.4, 0.5, 0.7]);

    expect(rows).toHaveLength(21);
    expect(rows[0]?.threshold).toBe(0);
    expect(rows[20]?.threshold).toBe(1);
    expect(rows.filter((row) => row.threshold === 0.4)).toHaveLength(1);
    expect(rows.filter((row) => row.threshold === 0.7)).toHaveLength(1);
  });

  test("adds an operating point that the sweep does not already contain", () => {
    const rows = buildThresholdSweep([], [0.33]);
    const thresholds = rows.map((row) => row.threshold);

    expect(rows).toHaveLength(22);
    expect(thresholds).toContain(0.33);
    expect([...thresholds].sort((left, right) => left - right)).toEqual(thresholds);
  });

  test("computes a threshold row with metrics", () => {
    const row = computeThresholdRow([sample({ authorLabel: "VIOLATION", probability: 0.9 })], 0.5);

    expect(row.matrix).toEqual({
      truePositive: 1,
      falsePositive: 0,
      trueNegative: 0,
      falseNegative: 0,
    });
    expect(row.metrics.precision).toBe(1);
    expect(row.metrics.recall).toBe(1);
    expect(row.metrics.specificity).toBeNull();
  });

  test("reports gate-state counts separately from the sweep", () => {
    const rows = buildGateStateMatrix([
      sample({ authorLabel: "VIOLATION", probability: 0.9, outcome: "FAIL" }),
      sample({ authorLabel: "VIOLATION", probability: 0.5, outcome: "WARN" }),
      sample({ authorLabel: "NO_VIOLATION", probability: null }),
    ]);

    expect(rows).toContainEqual({ authorLabel: "VIOLATION", outcome: "FAIL", count: 1 });
    expect(rows).toContainEqual({ authorLabel: "VIOLATION", outcome: "WARN", count: 1 });
    expect(rows).toContainEqual({ authorLabel: "NO_VIOLATION", outcome: "PASS", count: 0 });
  });
});

describe("operational counts and repeats", () => {
  test("counts availability and separates skipped from unavailable", () => {
    const counts = countOperational([
      sample({ authorLabel: "NO_VIOLATION", probability: 0.1 }),
      sample({ authorLabel: "NO_VIOLATION", probability: 0.2 }),
      sample({ authorLabel: "NO_VIOLATION", probability: null }),
      sample({ authorLabel: "NO_VIOLATION", probability: null, outcome: "SKIPPED" }),
    ]);

    expect(counts).toEqual({
      attempted: 4,
      evaluated: 2,
      unavailable: 1,
      skipped: 1,
      availabilityRate: 0.5,
    });
  });

  test("summarizes repeat variability and threshold flips", () => {
    const samples = [
      sample({ fixtureId: "f1", repeat: 0, probability: 0.1, authorLabel: "NO_VIOLATION" }),
      sample({ fixtureId: "f1", repeat: 1, probability: 0.9, authorLabel: "NO_VIOLATION" }),
      sample({ fixtureId: "f1", repeat: 2, probability: 0.1, authorLabel: "NO_VIOLATION" }),
      sample({ fixtureId: "f1", repeat: 3, probability: 0.9, authorLabel: "NO_VIOLATION" }),
      sample({ fixtureId: "f1", repeat: 4, probability: null, authorLabel: "NO_VIOLATION" }),
    ];
    const repeats = buildRepeats(samples, 0.5);
    const first = repeats[0];

    expect(repeats).toHaveLength(1);
    expect(first?.sampleCount).toBe(5);
    expect(first?.evaluatedCount).toBe(4);
    expect(first?.thresholdCrossings).toBe(3);
    expect(first?.flipRate).toBe(1);
    expect(first?.standardDeviation).toBeCloseTo(0.4, 10);
  });
});

describe("runtime gate boundaries via the real built-in batch", () => {
  test.each([
    [0.399, "PASS"],
    [0.4, "WARN"],
    [0.699, "WARN"],
    [0.7, "FAIL"],
  ] as const)("maps scope probability %s to %s", async (probability, outcome) => {
    const [scopeOutcome] = await gateOutcomes(probability, 0.1);

    expect(scopeOutcome).toBe(outcome);
  });

  test.each([
    [0.499, "PASS"],
    [0.5, "WARN"],
    [1, "WARN"],
  ] as const)(
    "maps complexity probability %s to %s and never fails",
    async (probability, outcome) => {
      const [, complexityOutcome] = await gateOutcomes(0.1, probability);

      expect(complexityOutcome).toBe(outcome);
      expect(complexityOutcome).not.toBe("FAIL");
    },
  );
});
