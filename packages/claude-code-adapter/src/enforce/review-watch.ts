import type { LocalReviewHistory, ReviewHistoryRecord } from "@jevguard/node-infra/history";
import type { EnforceResultFacts } from "./types";

/** How often the gate looks for the unit's review while it waits. */
export const ENFORCE_WATCH_INTERVAL_MS = 100;

interface FileMetadata {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface ReviewWatchDependencies {
  readonly history: Pick<LocalReviewHistory, "readStrict">;
  readonly historyPath: string;
  /** Metadata of the history file, or `null` when it does not exist yet. */
  readonly statOf: (path: string) => FileMetadata | null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly monotonicNow: () => number;
}

function metadataKey(metadata: FileMetadata | null): string {
  return metadata === null ? "missing" : `${metadata.size}:${metadata.mtimeMs}`;
}

/**
 * The review the gate decides on: only the fields that carry a rule's identity, its
 * severity and its outcome. No patch, task, path or probability leaves the record.
 */
function factsOf(record: ReviewHistoryRecord): readonly EnforceResultFacts[] {
  return record.results.map((result): EnforceResultFacts => {
    if (result.kind === "RULE") {
      return {
        kind: "RULE",
        ruleId: result.ruleId,
        severity: result.severity,
        outcome: result.outcome,
      };
    }

    if (result.kind === "BUILT_IN") {
      return {
        kind: "BUILT_IN",
        ruleId: null,
        severity: result.severity,
        outcome: result.outcome,
      };
    }

    return { kind: "REVIEW", ruleId: null, severity: null, outcome: result.outcome };
  });
}

/**
 * Waits for the review of one unit to land in the local history and returns its facts;
 * `null` when it does not settle within `budgetMs`. The file is re-read only when its
 * metadata moves, so a wait that ends in a no-block never parses an unchanged file
 * over and over. A missing or unreadable history is simply "not yet": the caller's
 * deadline decides, and a spent deadline is a no-block.
 */
export async function waitForReview(
  dependencies: ReviewWatchDependencies,
  turnId: string,
  budgetMs: number,
): Promise<readonly EnforceResultFacts[] | null> {
  const deadline = dependencies.monotonicNow() + budgetMs;
  let lastMetadata = "unread";

  for (;;) {
    const metadata = metadataKey(dependencies.statOf(dependencies.historyPath));

    if (metadata !== lastMetadata) {
      lastMetadata = metadata;

      const read = await dependencies.history.readStrict();

      if (read.status === "READ") {
        const record = read.records.find((candidate) => candidate.turnId === turnId);

        if (record !== undefined) return factsOf(record);
      }
    }

    const left = deadline - dependencies.monotonicNow();

    if (left <= 0) return null;

    await dependencies.sleep(Math.min(ENFORCE_WATCH_INTERVAL_MS, left));
  }
}
