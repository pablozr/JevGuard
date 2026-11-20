import type { ShellDiffLimit, ShellDiffLimits, ShellDiffMeter } from "./types";

const MIB = 1024 * 1024;

/**
 * Owner-ratified limits (2026-10-13), sized by the shell diff cost benchmark.
 *
 * The time limits stay where they are after the Windows measurement of 2026-11-20
 * (issue #113): on a 201-file repository with 41 dirty paths, the four Git calls a
 * snapshot makes took 36 ms at p50, 43 ms at p95 and 76 ms at worst, and a pre+post
 * pair took 296 ms at p50 and 311 ms at worst, about ten times inside `timeMs` and
 * twenty-six inside `gitCallTimeoutMs`. The `UNAVAILABLE` seen on the Windows test
 * runner comes from dozens of repositories captured in parallel, not from a review.
 */
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
