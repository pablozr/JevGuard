import type { TurnFile } from "@jevguard/core";

/**
 * Author-assigned expected label for one synthetic scenario. This is the
 * scenario author's intent, never a ground-truth measurement.
 */
export type CalibrationLabel = "VIOLATION" | "NO_VIOLATION";

export type CalibrationDifficulty = "clear" | "borderline";

/** Marks every fixture as intentionally authored rather than observed in production. */
export type CalibrationProvenance = "synthetic-author";

export type CalibrationCheckId = "scopeCreep" | "complexity";

export const CALIBRATION_CATEGORIES = [
  "requested-direct",
  "necessary-test",
  "necessary-error-handling",
  "necessary-validation",
  "necessary-supporting-change",
  "existing-pattern",
  "explicitly-required-complexity",
  "incidental-edit",
  "unrequested-functional",
  "unrequested-refactor",
  "unrequested-dependency-config-docs",
  "unnecessary-abstraction",
  "premature-generalization",
  "excessive-indirection",
  "mixed-unrequested-overengineering",
] as const;

export type CalibrationCategory = (typeof CALIBRATION_CATEGORIES)[number];

/**
 * One deterministic synthetic calibration case: a task, complete per-file patches,
 * and independent expected Scope Creep and Complexity author labels.
 */
export interface SyntheticCalibrationFixture {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly provenance: CalibrationProvenance;
  readonly category: CalibrationCategory;
  readonly difficulty: CalibrationDifficulty;
  readonly task: string;
  readonly files: readonly TurnFile[];
  readonly expected: {
    readonly scopeCreep: CalibrationLabel;
    readonly complexity: CalibrationLabel;
  };
}

/** Runtime gate state or operational state observed for one check on one call. */
export type CalibrationOutcome = "PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE";

/**
 * One observed check result. `probability` is `null` whenever the check did not
 * produce a semantic judgment, so unavailable calls are never treated as passes.
 */
export interface CheckScoreSample {
  readonly fixtureId: string;
  readonly check: CalibrationCheckId;
  readonly repeat: number;
  readonly category: CalibrationCategory;
  readonly difficulty: CalibrationDifficulty;
  readonly authorLabel: CalibrationLabel;
  readonly outcome: CalibrationOutcome;
  readonly probability: number | null;
  /** Typed operational reason for a non-semantic result; never a raw error message. */
  readonly reason: string | null;
}

export interface ConfusionMatrix {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly trueNegative: number;
  readonly falseNegative: number;
}

/** Derived metrics where an undefined (zero-denominator) value stays `null`. */
export interface DerivedMetrics {
  readonly precision: number | null;
  readonly recall: number | null;
  readonly specificity: number | null;
  readonly f1: number | null;
}

export interface ThresholdRow {
  readonly threshold: number;
  readonly matrix: ConfusionMatrix;
  readonly metrics: DerivedMetrics;
}

export interface OperatingPointReport {
  readonly threshold: number;
  readonly label: string;
  readonly matrix: ConfusionMatrix;
  readonly metrics: DerivedMetrics;
}

export interface GateStateRow {
  readonly authorLabel: CalibrationLabel;
  readonly outcome: CalibrationOutcome;
  readonly count: number;
}

export interface QuantileSummary {
  readonly count: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly p10: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p90: number;
}

/**
 * Ten fixed bins: `[0.0,0.1)`, ..., `[0.9,1.0]`. The final bin sets
 * `includesUpperBound` so exactly `1.0` lands there.
 */
export interface HistogramBin {
  readonly lowerInclusive: number;
  readonly upperBound: number;
  readonly includesUpperBound: boolean;
}

export interface HistogramReport {
  readonly bins: readonly HistogramBin[];
  readonly counts: readonly number[];
}

export interface DistributionReport {
  readonly overall: QuantileSummary | null;
  readonly byAuthorLabel: {
    readonly violation: QuantileSummary | null;
    readonly noViolation: QuantileSummary | null;
  };
  readonly histogram: HistogramReport;
  readonly histogramByAuthorLabel: {
    readonly violation: HistogramReport;
    readonly noViolation: HistogramReport;
  };
}

export interface RepeatSummary {
  readonly fixtureId: string;
  readonly check: CalibrationCheckId;
  readonly sampleCount: number;
  readonly evaluatedCount: number;
  readonly mean: number | null;
  readonly min: number | null;
  readonly max: number | null;
  readonly standardDeviation: number | null;
  readonly thresholdCrossings: number;
  readonly flipRate: number | null;
}

export interface OperationalCounts {
  readonly attempted: number;
  readonly evaluated: number;
  readonly unavailable: number;
  readonly skipped: number;
  readonly availabilityRate: number | null;
}

/** Safe operational detail: typed reason only, never a raw error or response. */
export interface OperationalFailure {
  readonly fixtureId: string;
  readonly check: CalibrationCheckId;
  readonly reason: string;
}

export interface AuthorLabelCounts {
  readonly violation: number;
  readonly noViolation: number;
}

export interface CheckReport {
  readonly check: CalibrationCheckId;
  readonly operational: OperationalCounts;
  readonly authorLabelCounts: AuthorLabelCounts;
  readonly operatingPoints: readonly OperatingPointReport[];
  readonly gateStateMatrix: readonly GateStateRow[];
  readonly thresholdSweep: readonly ThresholdRow[];
  readonly distribution: DistributionReport;
  readonly repeats: readonly RepeatSummary[];
  readonly unavailable: readonly OperationalFailure[];
}

export interface SelectedQuadrantCounts {
  readonly noViolationNoViolation: number;
  readonly violationNoViolation: number;
  readonly noViolationViolation: number;
  readonly violationViolation: number;
}

export interface RunSelectionSummary {
  readonly totalFixtures: number;
  readonly selectedFixtures: number;
  readonly repeat: number;
  readonly plannedLogicalCalls: number;
  readonly concurrency: number;
  readonly difficultyFilter: CalibrationDifficulty | null;
  readonly categoryFilters: readonly CalibrationCategory[];
  readonly selectedByQuadrant: SelectedQuadrantCounts;
  readonly selectedByDifficulty: {
    readonly clear: number;
    readonly borderline: number;
  };
}

export interface SafeUsageTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly responsesWithUsage: number;
}

/** Safe run metadata: counts, hashes, and sanitized model IDs only. */
export interface SafeRunMetadata {
  readonly runId: string;
  readonly generatedAt: string;
  readonly dataset: string;
  readonly seed: string;
  readonly corpusHash: string;
  readonly questionsHash: string;
  readonly requestedModel: string;
  readonly returnedModels: Readonly<Record<string, number>>;
  readonly usage: SafeUsageTotals;
  readonly selection: RunSelectionSummary;
}

export interface CalibrationReport {
  readonly schemaVersion: 1;
  readonly disclaimer: string;
  readonly metadata: SafeRunMetadata;
  readonly checks: {
    readonly scopeCreep: CheckReport;
    readonly complexity: CheckReport;
  };
}
