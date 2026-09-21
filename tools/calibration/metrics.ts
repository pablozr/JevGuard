import type {
  AuthorLabelCounts,
  CalibrationCheckId,
  CalibrationLabel,
  CheckScoreSample,
  ConfusionMatrix,
  DerivedMetrics,
  DistributionReport,
  GateStateRow,
  HistogramBin,
  HistogramReport,
  OperationalCounts,
  OperatingPointReport,
  QuantileSummary,
  RepeatSummary,
  ThresholdRow,
} from "./types";

export const HISTOGRAM_BIN_COUNT = 10;

const AUTHOR_LABEL_ORDER: readonly CalibrationLabel[] = ["VIOLATION", "NO_VIOLATION"];
const SEMANTIC_OUTCOME_ORDER = ["PASS", "WARN", "FAIL"] as const;

export interface OperatingPointDefinition {
  readonly threshold: number;
  readonly label: string;
}

/** Scope Creep keeps binary author labels but reports both fixed error-gate points. */
export const SCOPE_OPERATING_POINTS: readonly OperatingPointDefinition[] = [
  { threshold: 0.4, label: "warn-or-fail" },
  { threshold: 0.7, label: "fail" },
];

/** Complexity is advisory: its only operating point is the fixed warning gate. */
export const COMPLEXITY_OPERATING_POINTS: readonly OperatingPointDefinition[] = [
  { threshold: 0.5, label: "warn" },
];

export function operatingPointsFor(check: CalibrationCheckId): readonly OperatingPointDefinition[] {
  return check === "scopeCreep" ? SCOPE_OPERATING_POINTS : COMPLEXITY_OPERATING_POINTS;
}

export function evaluatedProbabilities(samples: readonly CheckScoreSample[]): readonly number[] {
  const values: number[] = [];

  for (const sample of samples) {
    if (sample.probability !== null) {
      values.push(sample.probability);
    }
  }

  return values;
}

/**
 * Confusion cells over evaluated samples only. A sample is predicted positive when
 * its probability is at or above the threshold.
 */
export function computeConfusionMatrix(
  samples: readonly CheckScoreSample[],
  threshold: number,
): ConfusionMatrix {
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;

  for (const sample of samples) {
    if (sample.probability === null) {
      continue;
    }

    const actualPositive = sample.authorLabel === "VIOLATION";
    const predictedPositive = sample.probability >= threshold;

    if (actualPositive && predictedPositive) {
      truePositive += 1;
    } else if (actualPositive) {
      falseNegative += 1;
    } else if (predictedPositive) {
      falsePositive += 1;
    } else {
      trueNegative += 1;
    }
  }

  return { truePositive, falsePositive, trueNegative, falseNegative };
}

/** Zero-denominator metrics are `null`, never a fabricated `0` or `1`. */
export function computeDerivedMetrics(matrix: ConfusionMatrix): DerivedMetrics {
  const { truePositive, falsePositive, trueNegative, falseNegative } = matrix;

  const precision = ratio(truePositive, truePositive + falsePositive);
  const recall = ratio(truePositive, truePositive + falseNegative);
  const specificity = ratio(trueNegative, trueNegative + falsePositive);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);

  return { precision, recall, specificity, f1 };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function computeThresholdRow(
  samples: readonly CheckScoreSample[],
  threshold: number,
): ThresholdRow {
  const matrix = computeConfusionMatrix(samples, threshold);

  return { threshold, matrix, metrics: computeDerivedMetrics(matrix) };
}

export function buildOperatingPoints(
  check: CalibrationCheckId,
  samples: readonly CheckScoreSample[],
): readonly OperatingPointReport[] {
  return operatingPointsFor(check).map((point) => {
    const matrix = computeConfusionMatrix(samples, point.threshold);

    return {
      threshold: point.threshold,
      label: point.label,
      matrix,
      metrics: computeDerivedMetrics(matrix),
    };
  });
}

/**
 * Diagnostic sweep from `0.00` through `1.00` in `0.05` steps, using integer
 * arithmetic, plus any operating point that is not already present. Sorted
 * ascending with no ranking or recommendation.
 */
export function buildThresholdSweep(
  samples: readonly CheckScoreSample[],
  extraThresholds: readonly number[],
): readonly ThresholdRow[] {
  const thresholds: number[] = [];

  for (let step = 0; step <= 20; step += 1) {
    thresholds.push(step / 20);
  }

  for (const extra of extraThresholds) {
    if (!thresholds.some((value) => Math.abs(value - extra) < 1e-12)) {
      thresholds.push(extra);
    }
  }

  thresholds.sort((left, right) => left - right);

  return thresholds.map((threshold) => computeThresholdRow(samples, threshold));
}

/**
 * Linear interpolation between closest ranks (the R type-7 / `PERCENTILE.INC`
 * method): index `p * (n - 1)` into the ascending values.
 */
export function quantile(sortedValues: readonly number[], probability: number): number {
  if (sortedValues.length === 0) {
    throw new RangeError("quantile requires at least one value");
  }

  const position = probability * (sortedValues.length - 1);
  const lowerIndex = Math.floor(position);
  const fraction = position - lowerIndex;
  const lower = sortedValues[lowerIndex] ?? sortedValues[0] ?? 0;
  const upper = sortedValues[lowerIndex + 1] ?? lower;

  return lower + fraction * (upper - lower);
}

export function summarize(values: readonly number[]): QuantileSummary | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const first = sorted[0] ?? 0;
  const last = sorted[sorted.length - 1] ?? first;

  return {
    count: sorted.length,
    min: first,
    max: last,
    mean: sum / sorted.length,
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
  };
}

export function histogramBins(): readonly HistogramBin[] {
  const bins: HistogramBin[] = [];

  for (let index = 0; index < HISTOGRAM_BIN_COUNT; index += 1) {
    bins.push({
      lowerInclusive: index / HISTOGRAM_BIN_COUNT,
      upperBound: (index + 1) / HISTOGRAM_BIN_COUNT,
      includesUpperBound: index === HISTOGRAM_BIN_COUNT - 1,
    });
  }

  return bins;
}

export function buildHistogram(values: readonly number[]): HistogramReport {
  const counts = new Array<number>(HISTOGRAM_BIN_COUNT).fill(0);

  for (const value of values) {
    const index = histogramIndex(value);
    counts[index] = (counts[index] ?? 0) + 1;
  }

  return { bins: histogramBins(), counts };
}

function histogramIndex(value: number): number {
  if (value >= 1) {
    return HISTOGRAM_BIN_COUNT - 1;
  }

  const index = Math.floor(value * HISTOGRAM_BIN_COUNT);

  return Math.min(HISTOGRAM_BIN_COUNT - 1, Math.max(0, index));
}

export function buildDistribution(samples: readonly CheckScoreSample[]): DistributionReport {
  const violation = evaluatedProbabilities(
    samples.filter((sample) => sample.authorLabel === "VIOLATION"),
  );
  const noViolation = evaluatedProbabilities(
    samples.filter((sample) => sample.authorLabel === "NO_VIOLATION"),
  );
  const overall = evaluatedProbabilities(samples);

  return {
    overall: summarize(overall),
    byAuthorLabel: {
      violation: summarize(violation),
      noViolation: summarize(noViolation),
    },
    histogram: buildHistogram(overall),
    histogramByAuthorLabel: {
      violation: buildHistogram(violation),
      noViolation: buildHistogram(noViolation),
    },
  };
}

export function buildAuthorLabelCounts(samples: readonly CheckScoreSample[]): AuthorLabelCounts {
  let violation = 0;
  let noViolation = 0;

  for (const sample of samples) {
    if (sample.authorLabel === "VIOLATION") {
      violation += 1;
    } else {
      noViolation += 1;
    }
  }

  return { violation, noViolation };
}

export function countOperational(samples: readonly CheckScoreSample[]): OperationalCounts {
  let evaluated = 0;
  let unavailable = 0;
  let skipped = 0;

  for (const sample of samples) {
    if (sample.probability !== null) {
      evaluated += 1;
    } else if (sample.outcome === "SKIPPED") {
      skipped += 1;
    } else {
      unavailable += 1;
    }
  }

  return {
    attempted: samples.length,
    evaluated,
    unavailable,
    skipped,
    availabilityRate: samples.length === 0 ? null : evaluated / samples.length,
  };
}

export function buildGateStateMatrix(
  samples: readonly CheckScoreSample[],
): readonly GateStateRow[] {
  const rows: GateStateRow[] = [];

  for (const authorLabel of AUTHOR_LABEL_ORDER) {
    for (const outcome of SEMANTIC_OUTCOME_ORDER) {
      const count = samples.filter(
        (sample) => sample.authorLabel === authorLabel && sample.outcome === outcome,
      ).length;

      rows.push({ authorLabel, outcome, count });
    }
  }

  return rows;
}

/**
 * Per-fixture repeat variability over evaluated probabilities. Standard deviation
 * is the population value; threshold crossings count adjacent evaluated pairs that
 * land on opposite sides of the operating threshold.
 */
export function buildRepeats(
  samples: readonly CheckScoreSample[],
  threshold: number,
): readonly RepeatSummary[] {
  const groups = new Map<string, CheckScoreSample[]>();

  for (const sample of samples) {
    const existing = groups.get(sample.fixtureId);

    if (existing === undefined) {
      groups.set(sample.fixtureId, [sample]);
    } else {
      existing.push(sample);
    }
  }

  const summaries: RepeatSummary[] = [];

  for (const [fixtureId, group] of groups) {
    const ordered = [...group].sort((left, right) => left.repeat - right.repeat);
    const values = ordered
      .map((sample) => sample.probability)
      .filter((value): value is number => value !== null);
    const crossings = countThresholdCrossings(ordered, threshold);

    summaries.push({
      fixtureId,
      check: ordered[0]?.check ?? "scopeCreep",
      sampleCount: ordered.length,
      evaluatedCount: values.length,
      mean: mean(values),
      min: values.length === 0 ? null : Math.min(...values),
      max: values.length === 0 ? null : Math.max(...values),
      standardDeviation: populationStandardDeviation(values),
      thresholdCrossings: crossings.crossings,
      flipRate: crossings.pairs === 0 ? null : crossings.crossings / crossings.pairs,
    });
  }

  return summaries;
}

function countThresholdCrossings(
  ordered: readonly CheckScoreSample[],
  threshold: number,
): { readonly crossings: number; readonly pairs: number } {
  let crossings = 0;
  let pairs = 0;
  let previous: number | null = null;

  for (const sample of ordered) {
    if (sample.probability === null) {
      continue;
    }

    if (previous !== null) {
      pairs += 1;

      if (previous >= threshold !== sample.probability >= threshold) {
        crossings += 1;
      }
    }

    previous = sample.probability;
  }

  return { crossings, pairs };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  return values.reduce((total, value) => total + value, 0) / values.length;
}

function populationStandardDeviation(values: readonly number[]): number | null {
  const average = mean(values);

  if (average === null) {
    return null;
  }

  const variance =
    values.reduce((total, value) => total + (value - average) ** 2, 0) / values.length;

  return Math.sqrt(variance);
}
