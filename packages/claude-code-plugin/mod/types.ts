import type {
  ProposalFailureCode,
  ProposalRequestFile,
  ReviewFeedLine,
} from "@jevguard/claude-code-adapter/presentation";

/** The feed file of the running session and the session id it belongs to. */
export interface FeedTarget {
  readonly file: string;
  readonly sessionId: string;
}

export interface Poller {
  cancel(): void;
}

/** Last feed text read for a file and its parsed lines, reused while the text is unchanged. */
export interface FeedCache {
  readonly file: string;
  readonly text: string;
  readonly lines: readonly ReviewFeedLine[];
}

/** One unit whose private proposal request is waiting, and the session it was seen in. */
export interface ProposalTask {
  readonly turnId: string;
  readonly target: FeedTarget;
}

export type TakenRequest =
  | { readonly status: "REQUEST"; readonly file: ProposalRequestFile }
  | { readonly status: "BLANK" }
  | { readonly status: "FAILED"; readonly code: ProposalFailureCode };

export type ProposalCompletion =
  | { readonly status: "TEXT"; readonly text: string }
  | { readonly status: "FAILED"; readonly code: ProposalFailureCode };
