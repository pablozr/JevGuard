import type {
  OperationalStatus,
  ReviewCounts,
  ReviewOutcome,
  SemanticVerdict,
} from "@jevguard/core";

export type ReviewFeedLane = "RULE" | "BUILT_IN" | "REVIEW";

/**
 * One result as the user-only feed carries it: identity, outcome and a probability or
 * a typed reason code. It never holds paths, severities, slices, findings or text.
 */
export type ReviewFeedResult = {
  readonly lane: ReviewFeedLane;
  readonly id: string | null;
  readonly sliceCount: number | null;
} & (
  | { readonly outcome: SemanticVerdict; readonly probability: number }
  | { readonly outcome: OperationalStatus; readonly reason: string }
);

/** A review of one unit began; written before the Jev calls. */
export interface ReviewFeedStarted {
  readonly v: 1;
  readonly kind: "STARTED";
  readonly turnId: string;
  readonly at: string;
}

/** A review of one unit finished; written after the local history record. */
export interface ReviewFeedRecorded {
  readonly v: 1;
  readonly kind: "RECORDED";
  readonly turnId: string;
  readonly at: string;
  readonly counts: ReviewCounts;
  readonly causes: readonly string[];
  readonly results: readonly ReviewFeedResult[];
  /** Present only when the worker wrote a private proposal request for this unit. */
  readonly proposal?: true;
}

export type ReviewFeedLine = ReviewFeedStarted | ReviewFeedRecorded;

/** The process variables the feed location derives from; `undefined` when unset. */
export interface FeedEnvironment {
  readonly xdgDataHome: string | undefined;
  readonly userProfile: string | undefined;
  readonly home: string | undefined;
}

/** Where a remediation proposal goes: a panel only the user sees, or the agent itself. */
export type ProposalDelivery = "user" | "agent";

/**
 * One private request for a remediation proposal, written by the worker and read once
 * by the in-session mod. Sensitive: it carries the task and the attributed patch, so it
 * is `0600` in a `0700` directory, blanked by the mod as it reads it, and removed by the
 * worker when blank or expired.
 */
export interface ProposalRequestFile {
  readonly v: 1;
  readonly kind: "PROPOSAL_REQUEST";
  readonly turnId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly delivery: ProposalDelivery;
  readonly model: string | null;
  readonly system: string;
  readonly prompt: string;
}

/** A finished proposal as the panel and the agent delivery carry it. */
export interface ProposalView {
  readonly turnId: string;
  readonly unit: string;
  readonly text: string;
  readonly applyInstruction: string;
  readonly delivery: ProposalDelivery;
}

/** Why a proposal did not reach the user; a closed set, never text, paths or findings. */
export type ProposalFailureCode =
  | "REQUEST_UNREADABLE"
  | "REQUEST_INVALID"
  | "MODEL_REFUSED"
  | "MODEL_API_ERROR"
  | "MODEL_EMPTY_REPLY"
  | "MODEL_ABORTED"
  | "DELIVERY_FAILED";

/** What the session shows for one recorded review. `line` and `toast` are `null` when not shown. */
export interface ReviewDisplay {
  readonly outcome: ReviewOutcome;
  readonly unit: string;
  readonly line: string | null;
  readonly status: string;
  readonly toast: string | null;
}

/** Which reviews were already shown, and when polling was last armed (`null` when idle). */
export interface FeedWatch {
  readonly shown: readonly string[];
  readonly armedAtMs: number | null;
}

export interface WatchTick {
  readonly watch: FeedWatch;
  readonly displays: readonly ReviewDisplay[];
  /** Turn ids of fresh reviews whose private proposal request is waiting for the mod. */
  readonly proposals: readonly string[];
  readonly status: string | null;
  readonly stop: boolean;
}
