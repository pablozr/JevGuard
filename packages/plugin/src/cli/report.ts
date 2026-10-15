import { aggregateReviewHistory, type ReviewReport } from "@jevguard/core";
import { createProcessFeedbackDependencies } from "./feedback/perform";

/**
 * Reads the bounded local review history and feedback and aggregates them for
 * `jevguard report`. A missing, empty, or unreadable history is an empty report rather
 * than an error: the history read never throws and counts malformed lines instead. An
 * unreadable feedback file rejects, so a calibration is never silently wrong.
 */
export async function performReport(): Promise<ReviewReport> {
  const { history, store } = createProcessFeedbackDependencies();
  const [{ records, skippedLineCount }, feedback] = await Promise.all([
    history.read(),
    store.read(),
  ]);

  if (feedback.status === "FAILED") {
    throw new Error("FEEDBACK_READ_FAILED");
  }

  return aggregateReviewHistory(records, skippedLineCount, feedback.records);
}
