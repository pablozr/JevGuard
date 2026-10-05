import type {
  OperationalStatus,
  ReviewCounts,
  RuleEvidenceMetadata,
  RuleSeverity,
  SemanticVerdict,
  SkippedReason,
  UnavailableReason,
} from "@jevguard/core";

export type DeliveryStatus = "DELIVERED" | "FAILED";

interface RuleLogIdentity {
  readonly kind: "RULE";
  readonly ruleId: string | null;
  readonly severity: RuleSeverity | null;
  readonly scopedPaths: readonly string[];
  readonly evidence?: RuleEvidenceMetadata;
}

interface BuiltInLogIdentity {
  readonly kind: "BUILT_IN";
  readonly checkId: string;
  readonly severity: RuleSeverity;
  readonly scopedPaths: readonly string[];
}

interface ReviewLogIdentity {
  readonly kind: "REVIEW";
}

type SemanticLogResult = {
  readonly outcome: SemanticVerdict;
  readonly violationProbability: number;
};

type OperationalLogResult = {
  readonly outcome: OperationalStatus;
  readonly reason: SkippedReason | UnavailableReason;
};

/**
 * Nested per-result aggregate-log payload with an exact allowlist. The `kind`
 * discriminant selects the identity fields: a rule carries `ruleId`, a built-in
 * carries `checkId`, and a review-level result carries neither. Semantic outcomes
 * carry the raw probability; operational outcomes carry the typed reason.
 */
export type ReviewLogResult =
  | (RuleLogIdentity & SemanticLogResult)
  | (RuleLogIdentity & OperationalLogResult)
  | (BuiltInLogIdentity & SemanticLogResult)
  | (BuiltInLogIdentity & OperationalLogResult)
  | (ReviewLogIdentity & OperationalLogResult);

/** Aggregate summary projection for the structured log; `verdict` maps to `highestVerdict`. */
export interface ReviewLogSummary {
  readonly highestVerdict: SemanticVerdict | null;
  readonly hasUnavailable: boolean;
  readonly counts: ReviewCounts;
}

/** Exact structured-log allowlist for one aggregate turn review. */
export interface ReviewLogEntry {
  readonly turnId: string;
  readonly summary: ReviewLogSummary;
  readonly results: readonly ReviewLogResult[];
}

export interface StructuredLogSink {
  write(entry: ReviewLogEntry): Promise<DeliveryStatus>;
}
