import type {
  CaptureProblem,
  FileImage,
  GitShellChange,
  GitShellDiffFailure,
  PostImage,
  ResolveRepoPath,
} from "../acquisition";
import type { HookEvent } from "../hook-event";
import type { TurnResolution } from "../turn";

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
  /** Change time: moves when content is rewritten and the mtime is restored. */
  readonly ctimeMs: number;
  readonly ino: number;
  readonly isFile: boolean;
  /** `true` for a symlink or junction: `stat` never follows links. */
  readonly isLink: boolean;
}

/**
 * Read access to the project tree. Every call goes through this port so tests can
 * prove that a blocked path is never stat-ed or read by content capture.
 */
export interface CaptureFileReader {
  /** Does not follow links. `null` when the path does not exist; any other failure throws. */
  stat(path: string): FileStat | null;
  /** Fully resolved path, links and short names expanded; `null` when it does not exist. */
  realPath(path: string): string | null;
  /** Reads at most `maxBytes` bytes. */
  readBytes(path: string, maxBytes: number): Uint8Array;
}

/** Limit a shell Git diff can exceed; the unit becomes unavailable, never partial. */
export type ShellDiffLimit =
  | "STATUS_ENTRIES"
  | "CONTENT_BYTES"
  | "INDEX_READS"
  | "GIT_OUTPUT"
  | "GIT_CALL_TIME"
  | "TOTAL_TIME";

/**
 * Deterministic bounds of the Git diff around one shell call, applied per hook process.
 */
export interface ShellDiffLimits {
  /** Entries of one status and paths listed by a HEAD move. */
  readonly maxStatusEntries: number;
  /** Sum of the bytes read by the diff in one hook process. */
  readonly maxContentBytes: number;
  /** Git object reads of the HEAD recorded at Pre; two per file clean at Pre that is a candidate. */
  readonly maxIndexReads: number;
  readonly maxGitOutputBytes: number;
  readonly gitCallTimeoutMs: number;
  /** Total time allowed to the shell diff of one hook process. */
  readonly timeMs: number;
}

export type ShellDiffFailure =
  | { readonly kind: Extract<GitShellDiffFailure, "UNPROVEN"> }
  | {
      readonly kind: Extract<GitShellDiffFailure, "LIMIT_EXCEEDED">;
      readonly limit: ShellDiffLimit;
    };

export type SnapshotResult =
  | ({ readonly status: "TAKEN" } & TakenSnapshot)
  | { readonly status: "FAILED"; readonly failure: ShellDiffFailure };

/** Pre-call snapshot as read back by the Post hook. */
export type ShellPreSnapshot =
  | ({ readonly status: "TAKEN" } & TakenSnapshot)
  | { readonly status: "LIMIT_EXCEEDED" }
  | { readonly status: "MISSING" };

/** Pre-call record as decoded from disk, before its pack is attached. */
export type ShellPreRecord =
  | {
      readonly status: "TAKEN";
      readonly snapshot: GitSnapshot;
      readonly pack: readonly PackSlice[];
    }
  | { readonly status: "LIMIT_EXCEEDED" };

/** Charges content and index reads against the limits; counting continues past a failure. */
export interface ShellDiffMeter {
  /** `false` when the charge takes the total past the limit. */
  chargeContent(bytes: number): boolean;
  /** `false` when the charge takes the reads past the limit. */
  chargeIndexRead(): boolean;
}

export interface BoundedRun extends GitRunOptions {
  /** Return an output overflow to the caller instead of treating it as a limit. */
  readonly tolerateOverflow?: boolean;
}

export interface GitRunOptions {
  readonly input?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export type GitRunFailure = "EXIT" | "TIMEOUT" | "OUTPUT_TOO_LARGE" | "SPAWN";

export type GitRunResult =
  | { readonly ok: true; readonly stdout: Uint8Array }
  | { readonly ok: false; readonly failure: GitRunFailure };

/** Runs `git` with an argument array and no shell; never throws. */
export type GitRunner = (
  args: readonly string[],
  cwd: string,
  options?: GitRunOptions,
) => GitRunResult;

export interface HookEnvironment {
  get(name: string): string | undefined;
}

/** Process-level inputs of capture; each one is a port so tests can fake it. */
export interface CaptureDependencies {
  readonly environment: HookEnvironment;
  readonly files: CaptureFileReader;
  readonly git: GitRunner;
}

/** Operational failures capture reports to the hook log; never carries content. */
export type CaptureReport =
  | "CAPTURE_READ_FAILED"
  | "HOOK_BUDGET_EXCEEDED"
  | "STATE_WRITE_FAILED"
  | "GIT_FAILED"
  | `SHELL_DIFF_LIMIT:${ShellDiffLimit}`
  | "SHELL_CROSS_CHECK_AGREE"
  | "SHELL_CROSS_CHECK_DISAGREE"
  | "SHELL_CROSS_CHECK_UNAVAILABLE";

/** Image of one file as read by capture, with the raw bytes' digest. */
export type ImageReading =
  | { readonly kind: "IMAGE"; readonly image: FileImage }
  | { readonly kind: "PROBLEM"; readonly problem: CaptureProblem };

/** A Git shell change as persisted: the pre-image content lives in a blob. */
export type StoredShellChange =
  | {
      readonly path: string;
      readonly preState: "CLEAN" | "DIRTY";
      readonly preImage: PostImage;
      readonly post: PostImage;
    }
  | { readonly path: string; readonly preState: "UNREAD" };

export type StoredGitDiff =
  | { readonly status: "AVAILABLE"; readonly changes: readonly StoredShellChange[] }
  | { readonly status: "FAILED"; readonly cause: GitShellDiffFailure };

/** Everything one hook process captured for its event, persisted in the same line. */
export interface LineCapture {
  readonly postImages?: readonly { readonly path: string; readonly image: PostImage }[];
  readonly gitDiff?: StoredGitDiff;
  readonly problems?: readonly CaptureProblem[];
}

/** One line of a unit's `events.jsonl`. */
export type StateLine =
  | { readonly v: 1; readonly event: HookEvent; readonly capture?: LineCapture }
  | { readonly v: 1; readonly taint: "CAPTURE_FAILED" };

/** First pre-image of a path in a unit; content lives in a digest-named blob. */
export type PreRecord =
  | { readonly v: 1; readonly path: string; readonly image: PostImage }
  | { readonly v: 1; readonly path: string; readonly problem: CaptureProblem };

/** How a dirty path may be observed: content hash, metadata only, or not at all. */
export type SnapshotKind = "READABLE" | "BLOCKED" | "OUTSIDE";

export interface SnapshotEntry {
  /** Path relative to the Git top level, with `/` separators. */
  readonly gitPath: string;
  /** Path relative to the project root; `null` when it lies outside it. */
  readonly repoPath: string | null;
  readonly kind: SnapshotKind;
  readonly state: "PRESENT" | "ABSENT";
  /**
   * sha256 of the raw bytes for a readable file that was read; the stat key (size, mtime,
   * ctime and inode) for blocked paths and for a readable one that was not read.
   */
  readonly fingerprint: string | null;
  /** Only on a present readable entry that was not read; the content cannot be kept. */
  readonly problem?: UnkeptContentProblem;
}

/** Why the content of a present readable file could not be kept. */
export type UnkeptContentProblem = Extract<
  CaptureProblem,
  "CONTENT_TOO_LARGE" | "CONTENT_NOT_TEXT"
>;

/** One path as observed by the shell diff, with its bytes when they were read. */
export interface ObservedPath {
  readonly entry: SnapshotEntry;
  readonly bytes: Uint8Array | null;
}

/** Read-only picture of the dirty files, HEAD and index links around one shell call. */
export interface GitSnapshot {
  readonly toplevel: string;
  readonly head: string | null;
  /** Sorted paths the index records as symlinks or gitlinks (modes 120000 and 160000). */
  readonly indexLinks: readonly string[];
  readonly entries: readonly SnapshotEntry[];
}

/** A snapshot with the bytes of every readable entry that was read, keyed by `gitPath`. */
export interface TakenSnapshot {
  readonly snapshot: GitSnapshot;
  readonly contents: ReadonlyMap<string, Uint8Array>;
}

/** Where the content of one entry lies inside a shell call's pack file. */
export interface PackSlice {
  readonly gitPath: string;
  readonly offset: number;
  readonly length: number;
}

/** Shell calls are covered by the adapter-owned Git diff, Git-ignored files excluded. */
export type ShellCoverage = "ADAPTER_GIT_DIFF";

/**
 * Durable record of one closed unit, written once for the detached review worker.
 * `projectRoot` is where the worker loads the repository policy.
 */
export interface ClaudeReviewHandoff {
  readonly version: 1;
  readonly turnId: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly projectRoot: string;
  readonly closedAt: string;
  readonly shellCoverage: readonly ShellCoverage[];
  /** Random per session state, so a reborn session never reuses an earlier unit's id. */
  readonly epoch: string;
  readonly resolution: TurnResolution;
}

export type HandoffDelivery = "CREATED" | "EXISTS" | "FAILED";

/** Receives each closed unit's handoff; the review worker plugs in behind it. */
export interface HandoffSink {
  deliver(handoff: ClaudeReviewHandoff): HandoffDelivery;
}

/** Wall-clock allowance of one hook process; capture and closure stop when it is spent. */
export interface Budget {
  expired(): boolean;
  remainingMs(): number;
}

/** Locations of one open unit inside the local state; nothing here is created eagerly. */
export interface UnitState {
  readonly sessionDirectory: string;
  readonly epoch: string;
  readonly ordinal: number;
  readonly directory: string;
  readonly eventsFile: string;
  readonly rootFile: string;
  readonly preDirectory: string;
  readonly blobsDirectory: string;
  readonly shellDirectory: string;
}

/** Removes a file tree, retrying transient failures; throws when it cannot. */
export type RemovePath = (path: string) => void;

/** What one hook process needs to capture the evidence of its own event. */
export interface CaptureContext extends CaptureDependencies {
  readonly unit: UnitState;
  readonly projectRoot: string;
  readonly resolveRepoPath: ResolveRepoPath;
  readonly budget: Budget;
  readonly monotonicNow: () => number;
  readonly shellDiffLimits: ShellDiffLimits;
  readonly report: (code: CaptureReport) => void;
}

/** Everything the Git shell diff needs from its host process. */
export interface GitShellContext {
  readonly git: GitRunner;
  readonly files: CaptureFileReader;
  readonly projectRoot: string;
  readonly resolveRepoPath: ResolveRepoPath;
  readonly budget: Budget;
  readonly limits: ShellDiffLimits;
  readonly meter: ShellDiffMeter;
}

export type GitDiffResult =
  | {
      readonly status: "AVAILABLE";
      readonly changes: readonly GitShellChange[];
      readonly problems: readonly CaptureProblem[];
    }
  | { readonly status: "FAILED"; readonly failure: ShellDiffFailure };

export interface CloseUnitInput extends CaptureDependencies {
  readonly unit: UnitState;
  readonly sessionId: string;
  /** `cwd` of the closing event; the project root when the unit never recorded one. */
  readonly fallbackRoot: string;
  readonly now: Date;
  readonly budget: Budget;
  readonly sink: HandoffSink;
  readonly removePath: RemovePath;
  readonly report: (code: CaptureReport | "HANDOFF_WRITE_FAILED") => void;
}
