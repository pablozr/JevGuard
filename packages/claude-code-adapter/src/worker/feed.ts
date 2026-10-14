import type { ClaudeReviewHandoff } from "../capture/types";
import { appendBoundedLog } from "../hook/log";
import {
  type ReviewFeedLine,
  reviewFeedDirectoryOf,
  reviewFeedFileOf,
  toFeedRecorded,
  toFeedStarted,
} from "../presentation";
import { feedEnvironmentOf } from "./environment";
import { isExpired, namesIn } from "./expiry";
import type { WorkerFileSystem, WorkerReviewFeed } from "./types";

const FEED_SUFFIX = ".jsonl";

/**
 * Writes the user-only presentation feed of one session under the user's data home. It
 * is decoration: every failure is swallowed so a review is never disturbed by it.
 */
export function createNodeReviewFeed(
  environment: { get(name: string): string | undefined },
  now: () => Date,
  files: WorkerFileSystem,
): WorkerReviewFeed {
  const feedEnvironment = feedEnvironmentOf(environment);

  function append(handoff: ClaudeReviewHandoff, line: ReviewFeedLine): boolean {
    const file = reviewFeedFileOf(feedEnvironment, handoff.sessionId);

    return file !== null && appendBoundedLog(file, line);
  }

  return {
    started(handoff) {
      append(handoff, toFeedStarted(handoff.turnId, now().toISOString()));
    },
    recorded(handoff, review, proposal) {
      const causes = handoff.resolution.status === "UNAVAILABLE" ? handoff.resolution.causes : [];

      return append(handoff, toFeedRecorded(review, causes, now().toISOString(), proposal));
    },
    sweep() {
      const directory = reviewFeedDirectoryOf(feedEnvironment);

      if (directory === null) return;

      const nowMs = now().getTime();

      for (const name of namesIn(files, directory).filter((entry) => entry.endsWith(FEED_SUFFIX))) {
        const path = `${directory}/${name}`;

        try {
          if (isExpired(files, path, nowMs)) files.remove(path);
        } catch {}
      }
    },
  };
}
