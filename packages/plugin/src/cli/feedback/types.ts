import type { FeedbackDecision } from "@jevguard/core";
import type { LocalFeedbackStore, LocalReviewHistory } from "@jevguard/node-infra";

export type FeedbackArguments =
  | { readonly kind: "LIST"; readonly json: boolean }
  | { readonly kind: "MARK"; readonly request: FeedbackMarkRequest }
  | { readonly kind: "INVALID_DECISION" }
  | { readonly kind: "USAGE" };

export interface FeedbackMarkRequest {
  readonly number: number;
  readonly decision: FeedbackDecision;
}

export interface FeedbackListItem {
  readonly number: number;
  readonly ruleId: string;
  readonly turnId: string;
  readonly timestamp: string;
  readonly violationProbability: number;
}

export type FeedbackListResult =
  | {
      readonly status: "LISTED";
      readonly listedAt: string;
      readonly total: number;
      readonly items: readonly FeedbackListItem[];
    }
  | { readonly status: "READ_FAILED" }
  | { readonly status: "WRITE_FAILED" };

export type FeedbackMarkResult =
  | {
      readonly status: "RECORDED";
      readonly ruleId: string;
      readonly decision: FeedbackDecision;
      readonly previous: FeedbackDecision | null;
      readonly timestamp: string;
      readonly violationProbability: number;
    }
  | {
      readonly status: "UNCHANGED";
      readonly ruleId: string;
      readonly decision: FeedbackDecision;
      readonly timestamp: string;
      readonly violationProbability: number;
    }
  | { readonly status: "NO_SELECTION" }
  | { readonly status: "NUMBER_OUT_OF_RANGE" }
  | { readonly status: "NO_LONGER_IN_HISTORY" }
  | { readonly status: "READ_FAILED" }
  | { readonly status: "WRITE_FAILED" };

export interface FeedbackDependencies {
  readonly history: Pick<LocalReviewHistory, "readStrict">;
  readonly store: LocalFeedbackStore;
  readonly now: () => Date;
}

/** The real wiring: the same dependencies with the full history surface kept for `report`. */
export interface ProcessFeedbackDependencies extends FeedbackDependencies {
  readonly history: LocalReviewHistory;
}
