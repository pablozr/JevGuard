import type { HookEvent, StopEvent, StopFailureEvent } from "../hook-event";

/** Full content of a file at one instant, or its absence. `digest` is capture-defined. */
export type FileImage =
  | { readonly state: "ABSENT" }
  | { readonly state: "PRESENT"; readonly digest: string; readonly content: string };

/** Identity of a file right after one attributed operation; carries no content. */
export type PostImage =
  | { readonly state: "ABSENT" }
  | { readonly state: "PRESENT"; readonly digest: string };

/**
 * One path a foreground shell call changed according to the adapter-owned Git diff.
 * `path` is already repo-relative. A `CLEAN` file carries its index image, which is
 * its trustworthy pre-image; a `DIRTY` file has none; an `UNREAD` file was blocked by
 * the evidence policy and its content was never read.
 */
export type GitShellChange =
  | {
      readonly path: string;
      readonly preState: "CLEAN";
      readonly indexImage: FileImage;
      readonly post: PostImage;
    }
  | { readonly path: string; readonly preState: "DIRTY"; readonly post: PostImage }
  | { readonly path: string; readonly preState: "UNREAD" };

/** Capture problems that make a unit unavailable without naming any content. */
export type CaptureProblem =
  | "CAPTURE_FAILED"
  | "CONTENT_TOO_LARGE"
  | "CONTENT_NOT_TEXT"
  | "BLOCKED_PATH";

/** Why a shell Git diff is unavailable: no proof, or one of its fixed limits exceeded. */
export type GitShellDiffFailure = "UNPROVEN" | "LIMIT_EXCEEDED";

export type GitShellDiff =
  | { readonly status: "AVAILABLE"; readonly changes: readonly GitShellChange[] }
  | { readonly status: "FAILED"; readonly cause: GitShellDiffFailure };

/**
 * Data captured around the unit's tool calls, keyed by repo-relative path (and by
 * `tool_use_id` where noted). Acquisition reads an entry only after the path passed
 * `checkFilePath`; a missing entry makes the unit unavailable.
 */
export interface UnitCapture {
  /** Image at the first `PreToolUse` that touched the path in the unit. */
  readonly preImages: ReadonlyMap<string, FileImage>;
  /** `tool_use_id` to the images recorded after that call, per attributed path. */
  readonly postImages: ReadonlyMap<string, ReadonlyMap<string, PostImage>>;
  /** Image re-read at the closing `Stop`, for universe files only. */
  readonly finalImages: ReadonlyMap<string, FileImage>;
  /** `tool_use_id` of a foreground shell call to its adapter-owned Git diff. */
  readonly gitDiffs: ReadonlyMap<string, GitShellDiff>;
  /** Problems met while capturing; each one becomes an acquisition reason. */
  readonly problems: ReadonlySet<CaptureProblem>;
}

/**
 * Resolves a host-reported path against the event `cwd` to a repo-relative path with
 * `/` separators, or `null` when it lies outside the repository.
 */
export type ResolveRepoPath = (rawPath: string, cwd: string) => string | null;

export type ClosingEvent = StopEvent | StopFailureEvent;

export interface QuiescentUnit {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly events: readonly HookEvent[];
  readonly closer: ClosingEvent;
}

export interface UnitSplit {
  readonly closed: readonly QuiescentUnit[];
  /** Events after the last closure; a prompt in them means a unit is still open. */
  readonly open: readonly HookEvent[];
}

export type ClaudeAcquisitionReason =
  | "TURN_FAILED"
  | "BACKGROUND_STATE_UNKNOWN"
  | "MISSING_PROMPT"
  | "PROMPT_NOT_TEXT"
  | "BLOCKED_PATH"
  | "MISSING_PATH"
  | "PATH_OUTSIDE_REPOSITORY"
  | "SHELL_BACKGROUND"
  | "SHELL_CHANGED_OUTSIDE_UNIVERSE"
  | "SHELL_GIT_DIFF_UNAVAILABLE"
  | "SHELL_DIFF_LIMIT_EXCEEDED"
  | "MCP_TOOL"
  | "UNKNOWN_TOOL"
  | "PAIRING_BROKEN"
  | "CAPTURE_FAILED"
  | "CONTENT_TOO_LARGE"
  | "CONTENT_NOT_TEXT"
  | "MISSING_CAPTURE"
  | "PATCH_BUDGET_EXCEEDED"
  | "UNATTRIBUTED_WRITER";

export interface AcquiredFile {
  readonly path: string;
  readonly before: FileImage;
  readonly after: FileImage;
}

export interface AcquiredUnit {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly prompts: readonly string[];
  readonly files: readonly AcquiredFile[];
}

export type UnitAcquisition =
  | { readonly status: "READY"; readonly unit: AcquiredUnit }
  | { readonly status: "SKIPPED"; readonly reason: "NO_ATTRIBUTED_PATCH" }
  | { readonly status: "UNAVAILABLE"; readonly reasons: readonly ClaudeAcquisitionReason[] };

export interface AcquireUnitInput {
  readonly unit: QuiescentUnit;
  readonly capture: UnitCapture;
  readonly resolveRepoPath: ResolveRepoPath;
}

/** Mutable accumulator for one unit's acquisition pass. */
export interface UnitAttribution {
  readonly reasons: Set<ClaudeAcquisitionReason>;
  readonly universe: Set<string>;
  readonly preImages: Map<string, FileImage>;
  readonly lastPostImages: Map<string, PostImage>;
  readonly universeAtShellStart: Map<string, ReadonlySet<string>>;
}
