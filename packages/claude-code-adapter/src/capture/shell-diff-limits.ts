import type { ShellDiffLimit, ShellDiffLimits, ShellDiffMeter } from "./types";

const MIB = 1024 * 1024;

/** Owner-ratified limits (2026-10-13), sized by the shell diff cost benchmark. */
export const DEFAULT_SHELL_DIFF_LIMITS: ShellDiffLimits = {
  maxStatusEntries: 2000,
  maxContentBytes: 16 * MIB,
  maxIndexReads: 40,
  maxGitOutputBytes: 16 * MIB,
  gitCallTimeoutMs: 2000,
  timeMs: 3000,
};

/** Thrown by the shell diff when one of its limits is exceeded. */
export class ShellDiffLimitError extends Error {
  constructor(readonly limit: ShellDiffLimit) {
    super(limit);
  }
}

export function createShellDiffMeter(limits: ShellDiffLimits): ShellDiffMeter {
  let contentBytes = 0;
  let indexReads = 0;

  return {
    chargeContent(bytes) {
      contentBytes += bytes;

      return contentBytes <= limits.maxContentBytes;
    },
    chargeIndexRead() {
      indexReads += 1;

      return indexReads <= limits.maxIndexReads;
    },
  };
}
