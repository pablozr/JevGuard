import { createTwoFilesPatch } from "diff";

const CONTEXT_LINES = 3;
const NULL_PATH = "/dev/null";

/** Time allowance, in milliseconds, for all patches rebuilt in one turn. */
export const DEFAULT_PATCH_BUDGET_MS = 2000;

/**
 * Builds the minimal unified patch (3 context lines) from `before` to `after`, with an
 * empty side headed `/dev/null`. Returns `""` when there is no hunk and `null` when
 * `timeoutMs` is spent before the patch is computed.
 */
export function buildUnifiedPatch(
  path: string,
  before: string,
  after: string,
  timeoutMs: number,
): string | null {
  if (timeoutMs <= 0) return null;

  const oldName = before === "" ? NULL_PATH : `a/${path}`;
  const newName = after === "" ? NULL_PATH : `b/${path}`;
  const patch = createTwoFilesPatch(oldName, newName, before, after, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: timeoutMs,
  });

  if (patch === undefined) return null;
  const headerStart = patch.indexOf("--- ");

  return headerStart === -1 || !patch.includes("\n@@ ") ? "" : patch.slice(headerStart);
}
