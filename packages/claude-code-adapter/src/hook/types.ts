import type {
  CaptureDependencies,
  HandoffSink,
  RemovePath,
  ShellDiffLimit,
  ShellDiffLimits,
} from "../capture/types";
import type { HookEventName, HookEventParseReason } from "../hook-event";

export type WorkerSpawnResult = "STARTED" | "ENTRY_MISSING";

/** Everything one hook process needs from its host; tests substitute fakes. */
export interface HookDependencies extends CaptureDependencies {
  readonly now: () => Date;
  /** Monotonic milliseconds, for the hook's own time allowance. */
  readonly monotonicNow: () => number;
  /** Deletes state trees; the failure of one removal never taints a unit. */
  readonly removePath: RemovePath;
  /** Builds the sink that receives each closed unit, given the handoff directory. */
  readonly createHandoffSink: (handoffDirectory: string) => HandoffSink;
  /** Starts the detached review worker without waiting for it; throws when it cannot start. */
  readonly spawnWorker: () => WorkerSpawnResult;
  /** Internal: tests and the benchmark. Defaults to the provisional shell diff limits. */
  readonly shellDiffLimits?: ShellDiffLimits;
}

/** Closed set of hook-log codes: no payload, prompt, path, command or session id. */
export type HookLogCode =
  | `PARSE_FAILED:${HookEventParseReason}`
  | "STATE_WRITE_FAILED"
  | "HOOK_BUDGET_EXCEEDED"
  | "STDIN_TOO_LARGE"
  | "CAPTURE_READ_FAILED"
  | "GIT_FAILED"
  | `SHELL_DIFF_LIMIT:${ShellDiffLimit}`
  | "SHELL_CROSS_CHECK_AGREE"
  | "SHELL_CROSS_CHECK_DISAGREE"
  | "SHELL_CROSS_CHECK_UNAVAILABLE"
  | "HANDOFF_WRITE_FAILED"
  | "WORKER_SPAWN_FAILED"
  | "WORKER_ENTRY_MISSING"
  | "STATE_ROOT_MISSING"
  | "INTERNAL";

export interface HookLogEntry {
  readonly timestamp: string;
  readonly event: HookEventName | "UNKNOWN";
  readonly code: HookLogCode;
}
