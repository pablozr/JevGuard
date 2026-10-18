import { ShellDiffLimitError } from "./shell-diff-limits";
import type { BoundedRun, GitRunResult, GitShellContext } from "./types";

const DECODER = new TextDecoder();

export function text(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

export function runBounded(
  context: GitShellContext,
  args: readonly string[],
  cwd: string,
  options: BoundedRun = {},
): GitRunResult {
  const { budget, limits } = context;

  if (budget.expired()) throw new ShellDiffLimitError("TOTAL_TIME");

  const remainingMs = budget.remainingMs();
  const callOwnsTimeout = limits.gitCallTimeoutMs <= remainingMs;
  const timeoutMs = Math.max(1, Math.ceil(Math.min(limits.gitCallTimeoutMs, remainingMs)));
  const maxOutputBytes = options.maxOutputBytes ?? limits.maxGitOutputBytes;
  const result = context.git(args, cwd, {
    ...(options.input === undefined ? {} : { input: options.input }),
    timeoutMs,
    maxOutputBytes,
  });

  if (result.ok) return result;

  if (result.failure === "TIMEOUT") {
    throw new ShellDiffLimitError(callOwnsTimeout ? "GIT_CALL_TIME" : "TOTAL_TIME");
  }

  if (result.failure === "OUTPUT_TOO_LARGE" && options.tolerateOverflow !== true) {
    throw new ShellDiffLimitError("GIT_OUTPUT");
  }

  return result;
}

export function chargeContent(context: GitShellContext, bytes: number): void {
  if (!context.meter.chargeContent(bytes)) throw new ShellDiffLimitError("CONTENT_BYTES");
}

export function chargeIndexRead(context: GitShellContext): void {
  if (!context.meter.chargeIndexRead()) throw new ShellDiffLimitError("INDEX_READS");
}

export function assertStatusEntries(context: GitShellContext, count: number): void {
  if (count > context.limits.maxStatusEntries) throw new ShellDiffLimitError("STATUS_ENTRIES");
}
