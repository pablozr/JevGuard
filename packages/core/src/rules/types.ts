import type { ParsedRule, RuleSeverity, UnavailableReason } from "../domain/types";

/**
 * Deterministic structural reason a rule document cannot become a validated rule.
 * Names stay limited to detectable structure and text contradictions.
 */
export type RuleParseErrorCode =
  | "MISSING_ID"
  | "INVALID_ID"
  | "MULTIPLE_RULES"
  | "DUPLICATE_ID"
  | "MISSING_SEVERITY"
  | "INVALID_SEVERITY"
  | "MALFORMED_METADATA"
  | "DUPLICATE_METADATA"
  | "MISSING_RULE"
  | "MISSING_VIOLATION"
  | "UNKNOWN_SECTION"
  | "DUPLICATE_SECTION"
  | "EMPTY_SECTION"
  | "EMPTY_ALLOWED"
  | "ALLOWED_EQUALS_VIOLATION";

/** The single `UnavailableReason` a parser failure maps to. */
export type InvalidRuleReason = Extract<UnavailableReason, "INVALID_RULE">;

export interface RuleParseSuccess {
  readonly status: "PARSED";
  readonly rule: ParsedRule;
}

/**
 * Failure of rule parsing. The affected review is `UNAVAILABLE` for
 * `INVALID_RULE` and is never sent to Jev.
 */
export interface RuleParseFailure {
  readonly status: "INVALID";
  readonly reason: InvalidRuleReason;
  readonly code: RuleParseErrorCode;
}

/** Result of parsing exactly one `.jev/rules.md` document. */
export type RuleParseResult = RuleParseSuccess | RuleParseFailure;

/**
 * Failure of parsing one rule block. `ruleId` carries the block's heading ID when
 * that heading is valid, and is `null` when the block has no valid ID.
 */
export type RuleCandidateFailure = RuleParseFailure & { readonly ruleId: string | null };

/**
 * Result of parsing one rule block. It shares the V0.1 success shape and extends
 * only failures with the heading ID needed to attribute the block.
 */
export type RuleCandidateResult = RuleParseSuccess | RuleCandidateFailure;

/**
 * Results of parsing every rule block of a `.jev/rules.md` document, in source
 * order. A document with no rule heading yields a single `MISSING_ID` candidate.
 */
export type RuleParseResults = readonly RuleCandidateResult[];

export interface RuleBlock {
  readonly id: string;
  readonly body: readonly string[];
}

export interface MetadataEntry {
  readonly key: string;
  readonly value: string;
}

export interface RuleMetadata {
  readonly severity: RuleSeverity;
  readonly scope: string | null;
}

export interface RuleSections {
  readonly rule: string;
  readonly violation: string;
  readonly allowed: string | null;
}

/** Internal discriminated result for one parsing step. */
export type ParseStep<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: RuleParseErrorCode };
