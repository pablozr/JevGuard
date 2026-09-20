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
 * A validated rule. `allowed` belongs to the same violation judgment and never
 * creates a separate model decision.
 */
export interface ParsedRule {
  readonly id: string;
  readonly severity: RuleSeverity;
  readonly scope: string | null;
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
