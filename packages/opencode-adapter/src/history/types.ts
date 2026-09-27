import type { ReviewLogEntry } from "../presentation/types";

/**
 * One persisted local review-history record: the exact structured-log allowlist plus
 * its ISO 8601 timestamp. This is the single allowlist of what may be written to disk;
 * there is no parallel projection.
 */
export interface ReviewHistoryRecord extends ReviewLogEntry {
  readonly timestamp: string;
}

/** Parsed history plus how many malformed lines were skipped, never thrown. */
export interface ReviewHistoryReadResult {
  readonly records: readonly ReviewHistoryRecord[];
  readonly skippedLineCount: number;
}

/** Minimal read-only environment port so tests never read the real process env. */
export interface HistoryEnvironment {
  get(name: string): string | undefined;
}

/**
 * Node filesystem port for the local review history. `readFile` and `sizeOf` return
 * `null` when the file is missing; `writeFileAtomic` must leave the destination
 * whole or untouched. Implementations must never throw into the review path.
 */
export interface ReviewHistoryFileSystem {
  readFile(path: string): Promise<string | null>;
  appendFile(path: string, data: string): Promise<void>;
  sizeOf(path: string): Promise<number | null>;
  writeFileAtomic(path: string, data: string): Promise<void>;
  ensureParentDirectory(path: string): Promise<void>;
}

/**
 * Explicit composition context for the history location: the process environment and
 * home directory, kept out of module scope so a test can point at a fake.
 */
export interface ReviewHistoryPathContext {
  readonly cwd: string;
  readonly environment: HistoryEnvironment;
  readonly homedir: string;
}

export interface LocalReviewHistoryDependencies {
  readonly context: ReviewHistoryPathContext;
  readonly fileSystem: ReviewHistoryFileSystem;
  readonly now: () => Date;
  readonly maxBytes?: number;
  readonly maxRecords?: number;
}

/**
 * Local review history surface. `append` never rejects: a write failure is contained
 * so it can never affect a review. `read` returns an empty result for a missing or
 * unreadable file and counts malformed lines instead of crashing.
 */
export interface LocalReviewHistory {
  append(entry: ReviewLogEntry): Promise<void>;
  read(): Promise<ReviewHistoryReadResult>;
}
