import type { ParsedRule, RuleSeverity, UnavailableReason } from "../domain/types";

/**
 * Deterministic structural reason a rule document cannot become a validated rule.
 * Names stay limited to detectable structure and text contradictions.
 */
export type RuleParseErrorCode =
  | "MISSING_ID"
  | "INVALID_ID"
  | "MULTIPLE_RULES"
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

export interface RuleHeading {
  readonly index: number;
  readonly id: string;
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
