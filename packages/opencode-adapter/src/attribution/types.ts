import type { Turn, TurnFile } from "@jevguard/core";

/**
 * One OpenCode 2.2.x session context message, narrowed to what attribution reads.
 * `type` is the host discriminator (`user`, `synthetic`, `assistant`, `idle`, ...);
 * `text` is only read on `user`/`synthetic` inputs; `completed` is true for an
 * assistant message with a completion time.
 */
export interface OpenCodeMessage {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly completed: boolean;
}

/** One file of a working-tree diff against `HEAD`, as returned by `vcs.diff`. */
export interface WorkingFileDiff {
  readonly file: string;
  readonly patch: string;
  readonly more?: boolean;
}

/** Bounded file content read from disk; `OVERSIZED` means over the per-file cap. */
export type FileContent =
  | { readonly kind: "TEXT"; readonly text: string }
  | { readonly kind: "MISSING" }
  | { readonly kind: "OVERSIZED" };

/**
 * Read port over the OpenCode 2.2.x plugin context. `snapshotWorking` reads the
 * working-tree diff including untracked files; `readFiles` reads current contents
 * relative to the project root; `parentSessionID` reads the session's parent, `null`
 * for a top-level session. Every method rejects on a host failure.
 */
export interface OpenCodeSessionFacade {
  listMessages(sessionID: string): Promise<readonly OpenCodeMessage[]>;
  snapshotWorking(): Promise<readonly WorkingFileDiff[]>;
  readFiles(paths: readonly string[]): Promise<ReadonlyMap<string, FileContent>>;
  parentSessionID(sessionID: string): Promise<string | null>;
}

/**
 * Host file diff shape accepted by `normalizeFileDiff`: a provided `patch` is used
 * verbatim, otherwise a unified patch is rebuilt from full `before`/`after` content.
 */
export interface OpenCodeFileDiff {
  readonly file?: string;
  readonly patch?: string;
  readonly before?: string;
  readonly after?: string;
}

export type PatchNormalization =
  | { readonly status: "PATCH"; readonly file: TurnFile }
  | { readonly status: "EMPTY" }
  | { readonly status: "INCOMPLETE" };

/**
 * Why an execution could not be attributed. `MISSING_TURN_START`: no start snapshot
 * (the plugin loaded mid-execution). `BOUNDARY_RACE`: a new execution started before
 * this one was consumed. `CONCURRENT_SESSIONS`: another top-level session ran an
 * execution in the same project at the same time. `INCOMPLETE_FILE_DIFF`: a cap was
 * exceeded, the host truncated a patch, or a tool wrote a path the diff does not show.
 */
export type AttributionFailureReason =
  | "MESSAGE_READ_FAILURE"
  | "MISSING_TASK_MESSAGE"
  | "EMPTY_TASK"
  | "DIFF_READ_FAILURE"
  | "INCOMPLETE_FILE_DIFF"
  | "MISSING_TURN_START"
  | "BOUNDARY_RACE"
  | "CONCURRENT_SESSIONS";

/**
 * Outcome of a succeeded execution. `ATTRIBUTED` is the only state that dispatches an
 * evaluation; `UNAVAILABLE` is never collapsed into a verdict.
 */
export type TurnAttribution =
  | { readonly status: "ATTRIBUTED"; readonly turn: Turn }
  | { readonly status: "ALREADY_PROCESSED" }
  | { readonly status: "UNAVAILABLE"; readonly reason: AttributionFailureReason }
  | { readonly status: "NONE" };

/**
 * In-memory guard against reviewing one assistant message twice. An implementation
 * must only mark after a turn has been attributed.
 */
export interface TurnDeduplicator {
  hasProcessed(assistantMessageID: string): boolean;
  markProcessed(assistantMessageID: string): void;
}
