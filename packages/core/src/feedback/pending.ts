import { compareStrings } from "../report/compare";
import type { ReportRecord } from "../report/types";
import { collectRuleFails, latestDecisions } from "./identity";
import type { FeedbackRecord, PendingFailList, RuleFail } from "./types";

/** Maximum number of unanswered FAILs one listing shows. */
export const FEEDBACK_LIST_LIMIT = 20;

/**
 * Unanswered rule FAILs, newest first with a deterministic tie-break, cut to `limit`.
 * `total` is the full pending count.
 */
export function listPendingFails(
  records: readonly ReportRecord[],
  feedback: readonly FeedbackRecord[],
  limit: number,
): PendingFailList {
  const answered = latestDecisions(feedback);
  const pending = [...collectRuleFails(records)]
    .filter(([key]) => !answered.has(key))
    .map(([, fail]) => fail)
    .sort(compareNewestFirst);

  return { items: pending.slice(0, limit), total: pending.length };
}

function compareNewestFirst(left: RuleFail, right: RuleFail): number {
  return (
    compareStrings(right.timestamp, left.timestamp) ||
    compareStrings(left.ruleId, right.ruleId) ||
    compareStrings(left.turnId, right.turnId)
  );
}
