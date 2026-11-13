import {
  createLocalFeedbackStore,
  createLocalReviewHistory,
  createNodeReviewHistoryFileSystem,
  createProcessReviewHistoryContext,
} from "@jevguard/node-infra";
import { listFeedback, markFeedback } from "./execute";
import type {
  FeedbackListResult,
  FeedbackMarkRequest,
  FeedbackMarkResult,
  ProcessFeedbackDependencies,
} from "./types";

/** Lists unanswered rule FAILs from the real local review history and feedback store. */
export function performFeedbackList(): Promise<FeedbackListResult> {
  return listFeedback(createProcessFeedbackDependencies());
}

/** Records a decision against the real local review history and feedback store. */
export function performFeedbackMark(request: FeedbackMarkRequest): Promise<FeedbackMarkResult> {
  return markFeedback(request, createProcessFeedbackDependencies());
}

/** Wires the real local review history and feedback store for the CLI. */
export function createProcessFeedbackDependencies(): ProcessFeedbackDependencies {
  const context = createProcessReviewHistoryContext();
  const fileSystem = createNodeReviewHistoryFileSystem();
  const now = () => new Date();

  return {
    history: createLocalReviewHistory({ context, fileSystem, now }),
    store: createLocalFeedbackStore({ context, fileSystem }),
    now,
  };
}
