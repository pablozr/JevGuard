import type { FeedbackRecord, FeedbackSelection } from "@jevguard/core";
import type { ReviewHistoryFileSystem, ReviewHistoryPathContext } from "../history/types";

export type FeedbackWriteStatus = "WRITTEN" | "FAILED";

/** Parsed feedback plus how many malformed lines were skipped; an I/O error is `FAILED`. */
export type FeedbackReadResult =
  | {
      readonly status: "READ";
      readonly records: readonly FeedbackRecord[];
      readonly skippedLineCount: number;
    }
  | { readonly status: "FAILED" };

/** The last listing snapshot, or `null` when absent or malformed; an I/O error is `FAILED`. */
export type FeedbackSelectionReadResult =
  | { readonly status: "READ"; readonly selection: FeedbackSelection | null }
  | { readonly status: "FAILED" };

/**
 * Local feedback store. It never throws: every I/O failure resolves to a `FAILED`
 * status so the caller can report it. Only identifiers, the decision, and timestamps
 * are ever written.
 */
export interface LocalFeedbackStore {
  read(): Promise<FeedbackReadResult>;
  append(record: FeedbackRecord): Promise<FeedbackWriteStatus>;
  readSelection(): Promise<FeedbackSelectionReadResult>;
  writeSelection(selection: FeedbackSelection): Promise<FeedbackWriteStatus>;
}

export interface LocalFeedbackStoreDependencies {
  readonly context: ReviewHistoryPathContext;
  readonly fileSystem: ReviewHistoryFileSystem;
  readonly maxBytes?: number;
  readonly maxRecords?: number;
}
