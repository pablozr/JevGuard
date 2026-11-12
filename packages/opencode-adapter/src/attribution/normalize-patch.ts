import { buildUnifiedPatch, DEFAULT_PATCH_BUDGET_MS } from "./build-patch";
import type { OpenCodeFileDiff, PatchNormalization } from "./types";

/**
 * Uses a provided `patch` verbatim, otherwise rebuilds a minimal unified patch
 * (3 context lines) from full `before`/`after`. Missing or incomplete content, or
 * a spent deadline, is `INCOMPLETE`, never partial evidence.
 */
export function normalizeFileDiff(
  diff: OpenCodeFileDiff,
  timeoutMs = DEFAULT_PATCH_BUDGET_MS,
): PatchNormalization {
  const path = typeof diff.file === "string" ? diff.file.trim() : "";

  if (path === "") {
    return { status: "INCOMPLETE" };
  }

  if (typeof diff.patch === "string" && diff.patch.trim() !== "") {
    return { status: "PATCH", file: { path, patch: diff.patch } };
  }

  const before = diff.before;
  const after = diff.after;

  if (typeof before !== "string" || typeof after !== "string") {
    return { status: "INCOMPLETE" };
  }

  if (before === after) {
    return { status: "EMPTY" };
  }

  const patch = buildUnifiedPatch(path, before, after, timeoutMs);

  if (patch === null) {
    return { status: "INCOMPLETE" };
  }

  return patch === "" ? { status: "EMPTY" } : { status: "PATCH", file: { path, patch } };
}
