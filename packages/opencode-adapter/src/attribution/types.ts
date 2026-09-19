import type { Turn, TurnFile } from "@jevguard/core";

/**
 * A single OpenCode message part. Attribution only reads `type:"text"` parts;
 * reasoning, tool, file, and metadata parts never contribute to the task.
 */
export interface OpenCodePart {
  readonly type: string;
  readonly text?: string;
}

export interface OpenCodeMessageTime {
  readonly created: number;
  readonly completed?: number;
}

export interface OpenCodeMessageInfo {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly time?: OpenCodeMessageTime;
  readonly parentID?: string;
  readonly error?: unknown;
  readonly summary?: unknown;
}

export interface OpenCodeMessageRecord {
  readonly info: OpenCodeMessageInfo;
  readonly parts: readonly OpenCodePart[];
}

/**
 * Host file diff as returned by OpenCode V1.18.31. `patch` is present on the
 * current snapshot shape; older generated types expose `before`/`after` as full
 * file contents instead. Attribution prefers `patch` and conservatively rebuilds
 * a unified patch from `before`/`after` when it is absent.
 */
export interface OpenCodeFileDiff {
  readonly file?: string;
  readonly patch?: string;
  readonly before?: string;
  readonly after?: string;
}

/**
 * Read port over the OpenCode session API. The concrete adapter unwraps the SDK
 * response and maps transport errors before returning.
 */
export interface OpenCodeSessionFacade {
  listMessages(input: { readonly sessionID: string }): Promise<readonly OpenCodeMessageRecord[]>;
  fetchDiff(input: {
    readonly sessionID: string;
    readonly messageID: string;
  }): Promise<readonly OpenCodeFileDiff[]>;
}

export interface AttributeTurnDependencies {
  readonly facade: OpenCodeSessionFacade;
  readonly deduplicator: TurnDeduplicator;
}

export type PatchNormalization =
  | { readonly status: "PATCH"; readonly file: TurnFile }
  | { readonly status: "EMPTY" }
  | { readonly status: "INCOMPLETE" };

export type AttributionFailureReason =
  | "MESSAGE_READ_FAILURE"
  | "MISSING_PARENT_MESSAGE"
  | "EMPTY_TASK"
  | "DIFF_READ_FAILURE"
  | "INCOMPLETE_FILE_DIFF";

/**
 * Outcome of reacting to an idle status. `ATTRIBUTED` is the only state that
 * dispatches an evaluation; `UNAVAILABLE` is never collapsed into a verdict.
 */
export type TurnAttribution =
  | { readonly status: "ATTRIBUTED"; readonly turn: Turn }
  | { readonly status: "ALREADY_PROCESSED" }
  | { readonly status: "UNAVAILABLE"; readonly reason: AttributionFailureReason }
  | { readonly status: "NONE" };

/**
 * In-memory guard against repeated idle events for one assistant message. An
 * implementation must only mark after a turn has been attributed so a transient
 * failure can be retried.
 */
export interface TurnDeduplicator {
  hasProcessed(assistantMessageID: string): boolean;
  markProcessed(assistantMessageID: string): void;
}
