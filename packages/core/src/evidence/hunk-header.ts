import type { HunkRange } from "./types";

export const HUNK_MARKER = /^@@ [^\n]*@@/gm;

export const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

/**
 * Reads the post-image range of the `ordinal`-th hunk header of a patch. A missing
 * length means one line, as in the unified-diff format. Returns `null` when the
 * hunk or its range is absent.
 */
export function hunkRangeOf(patch: string, ordinal: number): HunkRange | null {
  const header = Array.from(patch.matchAll(HUNK_MARKER))[ordinal]?.[0];

  if (header === undefined) {
    return null;
  }

  const range = HUNK_HEADER.exec(header);
  const start = range?.[3];

  if (start === undefined) {
    return null;
  }

  return { newStart: Number(start), newLines: range?.[4] === undefined ? 1 : Number(range[4]) };
}
