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
