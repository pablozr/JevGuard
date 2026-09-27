import { aggregateReviewHistory, type ReviewReport } from "@jevguard/core";
import {
  createLocalReviewHistory,
  createNodeReviewHistoryFileSystem,
  createProcessReviewHistoryContext,
} from "@jevguard/opencode-adapter";

/**
 * Reads the bounded local review history and aggregates it for `jevguard report`. A
 * missing, empty, or unreadable history is an empty report rather than an error: the
 * history read never throws and counts malformed lines instead.
 */
export async function performReport(): Promise<ReviewReport> {
  const history = createLocalReviewHistory({
    context: createProcessReviewHistoryContext(),
    fileSystem: createNodeReviewHistoryFileSystem(),
    now: () => new Date(),
  });
  const { records, skippedLineCount } = await history.read();

  return aggregateReviewHistory(records, skippedLineCount);
}
