import type {
  OperationalStatus,
  RuleEvidenceMetadata,
  SemanticVerdict,
  SkippedReason,
  UnavailableReason,
} from "../domain/types";
import type { ReviewCounts } from "../review/types";

/**
 * Aggregation view of one rule result in a persisted history record. It carries only
 * the fields aggregation needs plus the safe slice metadata; it never carries diff
 * content, and the adapter remains the single persistence allowlist.
 */
export interface ReportRuleResult {
  readonly kind: "RULE";
  readonly ruleId: string | null;
  readonly evidence?: RuleEvidenceMetadata;
}

/** Aggregation view of one built-in result in a persisted history record. */
export interface ReportBuiltInResult {
  readonly kind: "BUILT_IN";
  readonly checkId: string;
}

/** Aggregation view of one review-level result in a persisted history record. */
export interface ReportReviewResult {
  readonly kind: "REVIEW";
}

interface ReportSemanticResult {
  readonly outcome: SemanticVerdict;
  readonly violationProbability: number;
}

interface ReportOperationalResult {
  readonly outcome: OperationalStatus;
  readonly reason: SkippedReason | UnavailableReason;
}

/** Every result shape a parsed history record can carry, discriminated by `kind`. */
export type ReportResult =
  | (ReportRuleResult & ReportSemanticResult)
  | (ReportRuleResult & ReportOperationalResult)
  | (ReportBuiltInResult & ReportSemanticResult)
  | (ReportBuiltInResult & ReportOperationalResult)
  | (ReportReviewResult & ReportOperationalResult);

/** Aggregate summary carried by a persisted history record. */
export interface ReportSummary {
  readonly highestVerdict: SemanticVerdict | null;
  readonly hasUnavailable: boolean;
  readonly counts: ReviewCounts;
}

/**
 * One parsed local-history record: the structured-log allowlist plus its ISO 8601
 * timestamp. The aggregator recomputes totals from `results` and never trusts the
 * stored `summary`.
 */
export interface ReportRecord {
  readonly timestamp: string;
  readonly turnId: string;
  readonly summary: ReportSummary;
  readonly results: readonly ReportResult[];
}

/** Per-outcome counts with their total, over every result in every record. */
export interface ReportOutcomeTotals {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly unavailable: number;
  readonly skipped: number;
  readonly total: number;
}

/** One typed operational reason and how often it occurred, in deterministic code order. */
export interface ReportReasonCount<Reason extends string> {
  readonly reason: Reason;
  readonly count: number;
}

/** One built-in check ID and how many results it produced, in deterministic ID order. */
export interface ReportBuiltInCount {
  readonly checkId: string;
  readonly count: number;
}

/** One repository rule's outcome counts and how many of its evaluations were sliced. */
export interface ReportRuleBreakdown {
  readonly ruleId: string;
  readonly counts: ReportOutcomeTotals;
  readonly slicedRuleCount: number;
}

/**
 * Whole-versus-sliced coverage across every repository-rule evaluation.
 * `totalSliceJudgments` counts the judged slices of sliced evaluations only, matching
 * the toast's `slices <m>` suffix.
 */
export interface ReportEvaluationCoverage {
  readonly wholeEvaluations: number;
  readonly slicedEvaluations: number;
  readonly totalSliceJudgments: number;
}

/**
 * Deterministic aggregation over parsed local review-history records. Every collection
 * is sorted so equal history always renders the same report.
 */
export interface ReviewReport {
  readonly entryCount: number;
  readonly skippedLineCount: number;
  readonly firstTimestamp: string | null;
  readonly lastTimestamp: string | null;
  readonly outcomes: ReportOutcomeTotals;
  readonly unavailableReasons: readonly ReportReasonCount<UnavailableReason>[];
  readonly skippedReasons: readonly ReportReasonCount<SkippedReason>[];
  readonly builtIns: readonly ReportBuiltInCount[];
  readonly rules: readonly ReportRuleBreakdown[];
  readonly evaluation: ReportEvaluationCoverage;
}
