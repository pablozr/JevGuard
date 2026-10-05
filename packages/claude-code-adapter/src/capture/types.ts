import type {
  CaptureProblem,
  FileImage,
  GitShellDiff,
  PostImage,
  ResolveRepoPath,
} from "../acquisition";
import type { HookEvent } from "../hook-event";
import type { TurnResolution } from "../turn";

export interface FileStat {
  readonly size: number;
  readonly mtimeMs: number;
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

export interface GitRunResult {
  readonly ok: boolean;
  readonly stdout: Uint8Array;
}

/** Runs `git` with an argument array and no shell; never throws. */
export type GitRunner = (args: readonly string[], cwd: string, input?: string) => GitRunResult;

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
  | "SHELL_CROSS_CHECK_AGREE"
  | "SHELL_CROSS_CHECK_DISAGREE"
  | "SHELL_CROSS_CHECK_UNAVAILABLE";

/** Image of one file as read by capture, with the raw bytes' digest. */
export type ImageReading =
  | { readonly kind: "IMAGE"; readonly image: FileImage }
  | { readonly kind: "PROBLEM"; readonly problem: CaptureProblem };

/** A Git shell change as persisted: the index image content lives in a blob. */
export type StoredShellChange =
  | {
      readonly path: string;
      readonly preState: "CLEAN";
      readonly indexImage: PostImage;
      readonly post: PostImage;
    }
  | { readonly path: string; readonly preState: "DIRTY"; readonly post: PostImage }
  | { readonly path: string; readonly preState: "UNREAD" };

export type StoredGitDiff =
  | { readonly status: "AVAILABLE"; readonly changes: readonly StoredShellChange[] }
  | { readonly status: "FAILED" };

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
  /** Git blob hash for readable files, `size:mtime` for blocked ones. */
  readonly fingerprint: string | null;
}

/** Read-only picture of the dirty files, HEAD and index around one shell call. */
export interface GitSnapshot {
  readonly toplevel: string;
  readonly head: string | null;
  readonly indexDigest: string;
  readonly entries: readonly SnapshotEntry[];
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
  readonly report: (code: CaptureReport) => void;
}

/** Everything the Git shell diff needs from its host process. */
export interface GitShellContext {
  readonly git: GitRunner;
  readonly files: CaptureFileReader;
  readonly projectRoot: string;
  readonly resolveRepoPath: ResolveRepoPath;
  readonly budget: Budget;
}

export interface GitDiffResult {
  readonly diff: GitShellDiff;
  readonly problems: readonly CaptureProblem[];
}

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
