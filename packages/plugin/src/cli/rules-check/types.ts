import type {
  DiffParseFailureReason,
  JevEvaluationPort,
  PolicyConfigParser,
  PolicyLoader,
  TurnReview,
} from "@jevguard/core";

export type DiffSource =
  | { readonly kind: "FILE"; readonly path: string }
  | { readonly kind: "STDIN" };

export interface RulesCheckRequest {
  readonly diff: DiffSource;
  readonly task: string | null;
  readonly ruleId: string | null;
}

export interface RulesCheckArguments {
  readonly request: RulesCheckRequest;
  readonly json: boolean;
}

export type DiffReadFailureReason =
  | "DIFF_READ_FAILURE"
  | "DIFF_TOO_LARGE"
  | "DIFF_NOT_UTF8"
  | "STDIN_IS_TTY";

export type DiffRead =
  | { readonly status: "READ"; readonly text: string }
  | { readonly status: "FAILED"; readonly reason: DiffReadFailureReason };

export type RulesCheckResult =
  | { readonly status: "REVIEWED"; readonly review: TurnReview }
  | { readonly status: "RULE_NOT_FOUND" }
  | {
      readonly status: "INPUT_FAILED";
      readonly reason: DiffReadFailureReason | DiffParseFailureReason;
    };

export interface RulesCheckDependencies {
  readonly readDiff: (source: DiffSource) => Promise<DiffRead>;
  readonly policy: PolicyLoader;
  readonly parseConfig: PolicyConfigParser;
  readonly jev: JevEvaluationPort;
}
