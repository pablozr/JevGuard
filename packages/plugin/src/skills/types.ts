import type { RuleParseErrorCode, RuleSeverity } from "@jevguard/core";

export type RuleDocumentStatus = "valid" | "invalid";

/**
 * Safe, content-free summary of one `.jev/rules.md` parse. It carries only
 * counts, rule IDs, and parser error codes, so a validator can report on a
 * candidate document without exposing policy text or file contents.
 */
export interface RuleDocumentSummary {
  readonly status: RuleDocumentStatus;
  readonly ruleCount: number;
  readonly ruleIds: readonly string[];
  readonly invalidCount: number;
  readonly invalidRuleIds: readonly (string | null)[];
  readonly errorCodes: readonly string[];
}

/** Deterministic, content-free failure a validator can report for one path. */
export type RuleValidatorErrorCode =
  | "EXPECTED_ONE_PATH_ARGUMENT"
  | "INVALID_PATH"
  | "NOT_A_FILE"
  | "FILE_TOO_LARGE"
  | "READ_FAILURE";

export interface RuleValidatorFailure {
  readonly status: "error";
  readonly errorCode: RuleValidatorErrorCode;
}

/** Everything the bundled validator may print: safe summary or safe failure. */
export type RuleValidatorReport = RuleDocumentSummary | RuleValidatorFailure;

/** How an initialized rule's provenance was established. */
export type ProvenanceSource = "user" | "inferred";

/**
 * Deterministic structural code a provenance preamble can fail with. Codes stay
 * limited to detectable shape, association, and evidence-safety problems, so a
 * validator can report them without exposing rule text, evidence contents, or secrets.
 */
export type ProvenanceValidationCode =
  | "PROVENANCE_MISSING"
  | "PROVENANCE_MALFORMED"
  | "PROVENANCE_UNSAFE_PREAMBLE"
  | "PROVENANCE_INVALID_SOURCE"
  | "PROVENANCE_MISSING_EVIDENCE"
  | "PROVENANCE_INSUFFICIENT_EVIDENCE"
  | "PROVENANCE_INFERRED_SEVERITY"
  | "PROVENANCE_INVALID_EVIDENCE"
  | "PROVENANCE_UNKNOWN_RULE"
  | "PROVENANCE_MISSING_RULE";

/** One manifest entry: a rule ID, its source, and any relative POSIX evidence. */
export interface ProvenanceEntry {
  readonly id: string;
  readonly source: ProvenanceSource;
  readonly evidence: readonly string[];
}

/**
 * The parsed facts about one valid rule that provenance checking needs. Severity comes
 * from the production parser, so an `inferred` rule can be required to be `warning`
 * without re-reading the document.
 */
export interface ProvenanceRule {
  readonly id: string;
  readonly severity: RuleSeverity;
}

export type ProvenanceResult =
  | { readonly status: "valid"; readonly entries: readonly ProvenanceEntry[] }
  | { readonly status: "invalid"; readonly codes: readonly ProvenanceValidationCode[] };

/**
 * Every deterministic code the `jev-init` validator can report: the production rule
 * parser's codes, the provenance codes, and the two production config sections.
 */
export type InitValidationCode =
  | RuleParseErrorCode
  | ProvenanceValidationCode
  | "CONFIG_PARSE_INVALID"
  | "CONFIG_INVALID"
  | "REMEDIATION_INVALID";

/** Deterministic, content-free failure the `jev-init` validator can report per path. */
export type InitValidatorErrorCode =
  | "EXPECTED_TWO_PATH_ARGUMENTS"
  | "INVALID_PATH"
  | "NOT_A_FILE"
  | "SYMLINK_PATH"
  | "FILE_TOO_LARGE"
  | "READ_FAILURE";

export interface InitValidationSummary {
  readonly status: "valid" | "invalid";
  readonly ruleIds: readonly string[];
  readonly codes: readonly string[];
}

export interface InitValidatorFailure {
  readonly status: "error";
  readonly errorCode: InitValidatorErrorCode;
}

/** Everything the `jev-init` validator may print: safe summary or safe failure. */
export type InitValidatorReport = InitValidationSummary | InitValidatorFailure;
