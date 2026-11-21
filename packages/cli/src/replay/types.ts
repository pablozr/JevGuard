import type {
  DiffParseFailureReason,
  JevEvaluationPort,
  PolicyConfigParser,
  PolicyLoader,
  TurnReview,
} from "@jevguard/core";
import type { DiffReadFailureReason } from "../rules-check/types";

export const REPLAY_DEFAULT_LAST = 5;
export const REPLAY_MAX_LAST = 50;

export interface ReplayRequest {
  /** How many of the newest commits to replay, from 1 to {@link REPLAY_MAX_LAST}. */
  readonly last: number;
  readonly ruleId: string | null;
}

export interface ReplayArguments {
  readonly request: ReplayRequest;
  readonly json: boolean;
}

/** One commit read from the local Git history; a merge commit has more than one parent. */
export interface ReplayedCommit {
  readonly sha: string;
  readonly subject: string;
  readonly diff: string;
  readonly merge: boolean;
  /**
   * Set when the reader cut the patch at its output bound: `diff` is a prefix of the
   * commit's real patch, so the unit is unread and must not be judged.
   */
  readonly diffTruncated?: true;
}

export type HistoryRead =
  | { readonly status: "READ"; readonly commits: readonly ReplayedCommit[] }
  | { readonly status: "FAILED"; readonly reason: "GIT_UNAVAILABLE" | "NO_COMMITS" };

export type ReplayCommitResult =
  | { readonly sha: string; readonly status: "REVIEWED"; readonly review: TurnReview }
  | {
      readonly sha: string;
      readonly status: "INPUT_FAILED";
      readonly reason: DiffReadFailureReason | DiffParseFailureReason;
    }
  | { readonly sha: string; readonly status: "RULE_NOT_FOUND" }
  | {
      readonly sha: string;
      readonly status: "SKIPPED";
      readonly reason: "MERGE_COMMIT" | "NO_PATCH";
    };

export type ReplayResult =
  | { readonly status: "REPLAYED"; readonly commits: readonly ReplayCommitResult[] }
  | { readonly status: "FAILED"; readonly reason: "GIT_UNAVAILABLE" | "NO_COMMITS" };

export interface ReplayDependencies {
  readonly readHistory: (last: number) => Promise<HistoryRead>;
  readonly policy: PolicyLoader;
  readonly parseConfig: PolicyConfigParser;
  readonly jev: JevEvaluationPort;
}
