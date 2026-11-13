import {
  FEEDBACK_LIST_LIMIT,
  listPendingFails,
  planFeedbackDecision,
  resolveFeedbackTarget,
} from "@jevguard/core";
import type {
  FeedbackDependencies,
  FeedbackListResult,
  FeedbackMarkRequest,
  FeedbackMarkResult,
} from "./types";

/**
 * Lists the unanswered rule FAILs and pins the listed identities as the selection, so
 * the numbers shown keep their meaning until the next listing, even when it is empty.
 */
export async function listFeedback(deps: FeedbackDependencies): Promise<FeedbackListResult> {
  const [history, feedback] = await Promise.all([deps.history.readStrict(), deps.store.read()]);

  if (history.status === "FAILED" || feedback.status === "FAILED") {
    return { status: "READ_FAILED" };
  }

  const pending = listPendingFails(history.records, feedback.records, FEEDBACK_LIST_LIMIT);
  const identities = pending.items.map(({ turnId, ruleId }) => ({ turnId, ruleId }));
  const listedAt = deps.now().toISOString();
  const written = await deps.store.writeSelection({ version: 1, listedAt, items: identities });

  if (written === "FAILED") {
    return { status: "WRITE_FAILED" };
  }

  return {
    status: "LISTED",
    listedAt,
    total: pending.total,
    items: pending.items.map((item, index) => ({
      number: index + 1,
      ruleId: item.ruleId,
      turnId: item.turnId,
      timestamp: item.timestamp,
      violationProbability: item.violationProbability,
    })),
  };
}

/** Records the user's decision for a number from the last listing. */
export async function markFeedback(
  request: FeedbackMarkRequest,
  deps: FeedbackDependencies,
): Promise<FeedbackMarkResult> {
  const [selection, feedback, history] = await Promise.all([
    deps.store.readSelection(),
    deps.store.read(),
    deps.history.readStrict(),
  ]);

  if (
    selection.status === "FAILED" ||
    feedback.status === "FAILED" ||
    history.status === "FAILED"
  ) {
    return { status: "READ_FAILED" };
  }

  const target = resolveFeedbackTarget(selection.selection, request.number, history.records);

  if (target.status !== "FOUND") {
    return { status: target.status };
  }

  const { turnId, ruleId, timestamp, violationProbability } = target.fail;
  const plan = planFeedbackDecision(target.fail, request.decision, feedback.records);

  if (plan.status === "UNCHANGED") {
    return {
      status: "UNCHANGED",
      ruleId,
      decision: request.decision,
      timestamp,
      violationProbability,
    };
  }

  const written = await deps.store.append({
    turnId,
    ruleId,
    decision: request.decision,
    timestamp: deps.now().toISOString(),
  });

  if (written === "FAILED") {
    return { status: "WRITE_FAILED" };
  }

  return {
    status: "RECORDED",
    ruleId,
    decision: request.decision,
    previous: plan.previous,
    timestamp,
    violationProbability,
  };
}
