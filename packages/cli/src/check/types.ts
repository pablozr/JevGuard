import type { JevEvaluationPort, PolicyConfigParser, PolicyLoader } from "@jevguard/core";
import type { ReplayedCommit, ReplayCommitResult } from "../replay/types";

/** Hard cap on how many commits one `check` reviews, so one run never spends more calls. */
export const CHECK_MAX_COMMITS = 50;

export type CheckOutput = "TEXT" | "JSON" | "ANNOTATIONS";

export interface CheckRequest {
  /** A validated `base..head` revision range; `--staged` is not part of v1. */
  readonly range: string;
  /** How many of the newest commits of the range to review; `null` uses the whole range. */
  readonly last: number | null;
  readonly ruleId: string | null;
  /** Turn a not-judged commit into exit 1; off by default. */
  readonly strict: boolean;
}

export type ParsedCheckArguments =
  | { readonly kind: "RUN"; readonly request: CheckRequest; readonly output: CheckOutput }
  | { readonly kind: "STAGED_OUT_OF_V1" };

/** The ways reading the range fails: never a verdict, always a non-zero exit. */
export type CheckReadFailure =
  | { readonly status: "FAILED"; readonly reason: "GIT_UNAVAILABLE" | "RANGE_INVALID" }
  | { readonly status: "RANGE_TOO_LARGE"; readonly totalCommits: number; readonly limit: number };

export type RangeRead =
  | { readonly status: "READ"; readonly commits: readonly ReplayedCommit[] }
  | CheckReadFailure;

export type CheckResult =
  | { readonly status: "CHECKED"; readonly commits: readonly ReplayCommitResult[] }
  | CheckReadFailure;

export interface CheckDependencies {
  readonly readRange: (range: string, limit: number) => Promise<RangeRead>;
  readonly policy: PolicyLoader;
  readonly parseConfig: PolicyConfigParser;
  readonly jev: JevEvaluationPort;
}

/** One error-severity rule that reached FAIL, with the commit it was judged on. */
export interface CheckFailure {
  readonly sha: string;
  readonly ruleId: string | null;
  readonly violationProbability: number;
}

/** One warning: a rule `WARN` or a `warning`-severity rule that reached `FAIL`. */
export type CheckWarning = CheckFailure;

/** One commit the check could not judge completely. */
export interface CheckIncompleteCommit {
  readonly sha: string;
  readonly reason: string;
}

export interface CheckVerdict {
  readonly verdict: "PASS" | "WARN" | "FAIL" | "INCOMPLETE" | "RULE_NOT_FOUND";
  readonly failures: readonly CheckFailure[];
  readonly warnings: readonly CheckWarning[];
  readonly incomplete: readonly CheckIncompleteCommit[];
  readonly reviewedCommitCount: number;
  readonly skippedCommitCount: number;
}
