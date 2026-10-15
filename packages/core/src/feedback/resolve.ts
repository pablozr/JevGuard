import type { ReportRecord } from "../report/types";
import { collectRuleFails, failIdentityKey, latestDecisions } from "./identity";
import type {
  FailIdentity,
  FeedbackDecision,
  FeedbackDecisionPlan,
  FeedbackRecord,
  FeedbackSelection,
  FeedbackTargetResolution,
} from "./types";

/** Maps a 1-based listed number to its pinned FAIL, checking it is still in the history. */
export function resolveFeedbackTarget(
  selection: FeedbackSelection | null,
  number: number,
  records: readonly ReportRecord[],
): FeedbackTargetResolution {
  if (selection === null) {
    return { status: "NO_SELECTION" };
  }

  if (!Number.isInteger(number) || number < 1) {
    return { status: "NUMBER_OUT_OF_RANGE" };
  }

  const identity = selection.items[number - 1];

  if (identity === undefined) {
    return { status: "NUMBER_OUT_OF_RANGE" };
  }

  const fail = collectRuleFails(records).get(failIdentityKey(identity));

  return fail === undefined ? { status: "NO_LONGER_IN_HISTORY" } : { status: "FOUND", fail };
}

/** Decides whether an answer changes anything: the latest decision for the FAIL wins. */
export function planFeedbackDecision(
  target: FailIdentity,
  decision: FeedbackDecision,
  feedback: readonly FeedbackRecord[],
): FeedbackDecisionPlan {
  const previous = latestDecisions(feedback).get(failIdentityKey(target)) ?? null;

  return previous === decision ? { status: "UNCHANGED" } : { status: "RECORD", previous };
}
