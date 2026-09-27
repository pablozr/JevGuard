/**
 * One changed file attributed to a turn: its path and its complete textual patch.
 * Patches travel per file so scope selection never needs to split a global diff.
 */
export interface TurnFile {
  readonly path: string;
  readonly patch: string;
}

/**
 * A completed assistant turn: its parent task and the host-attributed per-file
 * patches. No attributed files, or only empty patches, mean no attributed patch;
 * never substitute the repository diff.
 */
export interface Turn {
  readonly id: string;
  readonly task: string;
  readonly files: readonly TurnFile[];
}

export type RuleSeverity = "error" | "warning";

/**
 * Extension class a rule's evidence may include. `code` covers source, config, and
 * data formats; `docs` covers prose documentation; `any` covers both.
 */
export type RuleEvidenceClass = "code" | "docs" | "any";

/**
 * Rule scope: inclusion globs plus `!`-prefixed exclusion globs. A path is in scope
 * when it matches at least one inclusion and no exclusion.
 */
export interface RuleScope {
  readonly include: readonly string[];
  readonly exclude: readonly string[];
}

/**
 * A validated rule. `allowed` belongs to the same violation judgment and never
 * creates a separate model decision; `evidence` selects which extension class the
 * rule's applicable files may draw from.
 */
export interface ParsedRule {
  readonly id: string;
  readonly severity: RuleSeverity;
  readonly scope: RuleScope | null;
  readonly evidence: RuleEvidenceClass;
  readonly description: string;
  readonly violation: string;
  readonly allowed: string | null;
}

/**
 * Evidence for one rule: the paths applicable to its scope plus the complete,
 * untruncated diff assembled only from those files' patches.
 */
export interface RuleEvidence {
  readonly files: readonly string[];
  readonly diff: string;
}

export interface ErrorThresholds {
  readonly warn: number;
  readonly fail: number;
}

export interface WarningThresholds {
  readonly warn: number;
}

/**
 * Thresholds per severity as violation probabilities in `[0, 1]`. An `error` rule
 * uses both `warn` and `fail`; a `warning` rule never fails.
 */
export interface GateThresholds {
  readonly error: ErrorThresholds;
  readonly warning: WarningThresholds;
}

export interface GateConfig {
  readonly version: 1;
  readonly thresholds: GateThresholds;
}

export type SemanticVerdict = "PASS" | "WARN" | "FAIL";

export type OperationalStatus = "SKIPPED" | "UNAVAILABLE";

export type ReviewOutcome = SemanticVerdict | OperationalStatus;

export type SkippedReason = "NO_ATTRIBUTED_PATCH" | "NO_SCOPE_MATCH";

export type UnavailableReason =
  | "INVALID_RULE"
  | "INVALID_CONFIG"
  | "MISSING_ATTRIBUTED_DIFF"
  | "OVERSIZED_DIFF"
  | "BLOCKED_EVIDENCE"
  | "SLICE_LIMIT_EXCEEDED"
  | "JEV_FAILURE";

/**
 * Gate result for a rule that reached Jev. `violationProbability` is the raw Noul
 * value in `[0, 1]`, never collapsed into a boolean.
 */
export type GateResult =
  | { readonly outcome: "PASS"; readonly violationProbability: number }
  | { readonly outcome: "WARN"; readonly violationProbability: number }
  | { readonly outcome: "FAIL"; readonly violationProbability: number };

/**
 * A state with no semantic judgment. Not a verdict, and never treat it as policy
 * compliance or failure.
 */
export type OperationalResult =
  | { readonly outcome: "SKIPPED"; readonly reason: SkippedReason }
  | { readonly outcome: "UNAVAILABLE"; readonly reason: UnavailableReason };

/** How a repository rule's evidence was planned for Jev: one whole slice or several ordered slices. */
export type EvidenceMode = "WHOLE" | "SLICED";

/** Shape of one planned evidence slice: the whole scoped diff, one file, or one unified-diff hunk. */
export type EvidenceSliceKind = "WHOLE" | "FILE" | "HUNK";

/** Safe, diff-free identity of one planned slice, in deterministic rule order. */
export interface RuleSliceSummary {
  readonly index: number;
  readonly path: string | null;
  readonly kind: EvidenceSliceKind;
  readonly hunkOrdinal: number | null;
}

/** One valid slice judgment, present only when every planned slice evaluated successfully. */
export interface RuleSliceJudgment {
  readonly index: number;
  readonly probability: number;
  readonly outcome: SemanticVerdict;
}

/**
 * Honest slice coverage for one repository-rule result. `sliceJudgments` is populated
 * only for a complete result; a failed or over-budget rule records counts and the
 * failing slice index plus the typed rule-level reason instead, and never exposes
 * partial sibling probabilities or diff content.
 */
export interface RuleEvidenceMetadata {
  readonly mode: EvidenceMode;
  readonly plannedSliceCount: number;
  readonly evaluatedSliceCount: number;
  readonly failedSliceCount: number;
  readonly notEvaluatedSliceCount: number;
  readonly slices: readonly RuleSliceSummary[];
  readonly sliceJudgments: readonly RuleSliceJudgment[];
  readonly failingSliceIndex: number | null;
  readonly failureReason: UnavailableReason | null;
}

export interface ReviewContext {
  readonly turnId: string;
  readonly ruleId: string | null;
  readonly severity: RuleSeverity | null;
  readonly scopedPaths: readonly string[];
}

/**
 * Result context for one local rule. `kind: "RULE"` completes the review-result
 * discrimination so presentation can switch exhaustively on `kind` with no absence
 * fallback.
 */
export interface RuleReviewContext extends ReviewContext {
  readonly kind: "RULE";
  readonly evidence?: RuleEvidenceMetadata;
}

export type RuleReviewResult = RuleReviewContext & (GateResult | OperationalResult);

/** Discriminants across the review lanes: local rules, built-in checks, review-level failures. */
export type ReviewResultKind = "RULE" | "BUILT_IN" | "REVIEW";

/**
 * Operational states a built-in check can reach. A built-in has no scope, so it
 * never reports `NO_SCOPE_MATCH`, and it shares the typed Jev failure contract.
 */
export type BuiltInSkippedReason = Extract<SkippedReason, "NO_ATTRIBUTED_PATCH">;

export type BuiltInUnavailableReason = Extract<
  UnavailableReason,
  "OVERSIZED_DIFF" | "BLOCKED_EVIDENCE" | "JEV_FAILURE"
>;

export type BuiltInOperationalResult =
  | { readonly outcome: "SKIPPED"; readonly reason: BuiltInSkippedReason }
  | { readonly outcome: "UNAVAILABLE"; readonly reason: BuiltInUnavailableReason };

/**
 * Result context for one built-in check. `ruleId` stays `null`; the `kind`
 * discriminant keeps it distinct from a local rule in the fully discriminated
 * review-result union.
 */
export interface BuiltInReviewContext extends ReviewContext {
  readonly kind: "BUILT_IN";
  readonly ruleId: null;
  readonly checkId: string;
  readonly severity: RuleSeverity;
}

export type BuiltInReviewResult = BuiltInReviewContext & (GateResult | BuiltInOperationalResult);

/**
 * Result reserved for a review lane that fails before reaching a check. It carries
 * no check identity, so both `ruleId` and `severity` are `null`.
 */
export interface ReviewLevelContext extends ReviewContext {
  readonly kind: "REVIEW";
  readonly ruleId: null;
  readonly severity: null;
}

export type ReviewLevelResult = ReviewLevelContext & OperationalResult;

/** Every result a turn review can carry, across rules, built-ins, and review-level failures. */
export type ReviewResult = RuleReviewResult | BuiltInReviewResult | ReviewLevelResult;
