import { createTwoFilesPatch } from "diff";
import type { AcquiredFile, FileImage } from "../acquisition";

const CONTEXT_LINES = 3;
const NULL_PATH = "/dev/null";

function content(image: FileImage): string {
  return image.state === "PRESENT" ? image.content : "";
}

function hasNetChange(file: AcquiredFile): boolean {
  if (file.before.state !== file.after.state) return true;

  return content(file.before) !== content(file.after);
}

/** Thrown when a patch cannot be computed inside its time allowance. */
export class PatchBudgetExceededError extends Error {
  constructor() {
    super("PATCH_BUDGET_EXCEEDED");
  }
}

/**
 * Builds the unified patch (pre-image to final image) for one file, headed with
 * `--- a/<path>` and `+++ b/<path>` (`/dev/null` for an absent side) so the core
 * slices it by hunk. Returns an empty string when the file has no net change and throws
 * `PatchBudgetExceededError` once `deadlineMs` (epoch milliseconds) passes.
 */
export function buildFilePatch(file: AcquiredFile, deadlineMs: number): string {
  if (!hasNetChange(file)) return "";

  const timeout = deadlineMs - Date.now();

  if (timeout <= 0) throw new PatchBudgetExceededError();

  const oldName = file.before.state === "ABSENT" ? NULL_PATH : `a/${file.path}`;
  const newName = file.after.state === "ABSENT" ? NULL_PATH : `b/${file.path}`;
  const patch = createTwoFilesPatch(
    oldName,
    newName,
    content(file.before),
    content(file.after),
    undefined,
    undefined,
    { context: CONTEXT_LINES, timeout },
  );

  if (patch === undefined) throw new PatchBudgetExceededError();
  const headerStart = patch.indexOf("--- ");

  return headerStart === -1 || !patch.includes("\n@@ ") ? "" : patch.slice(headerStart);
}
