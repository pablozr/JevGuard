import type { Turn, TurnFile } from "@jevguard/core";
import type { AcquiredUnit } from "../acquisition";
import { sessionTurnPrefixOf } from "../presentation/turn-id";
import { buildFilePatch } from "./build-patch";
import type { TurnOptions } from "./types";

/**
 * One prompt is the task verbatim; several keep their order and full text, each under
 * an `n of total` header. Nothing is truncated or summarized.
 */
export function encodeTask(prompts: readonly string[]): string {
  const [only] = prompts;

  if (prompts.length === 1 && only !== undefined) return only;

  return prompts
    .map((prompt, index) => `Prompt ${index + 1} of ${prompts.length}:\n${prompt}`)
    .join("\n\n");
}

export const DEFAULT_PATCH_BUDGET_MS = 2000;

export function unitTurnId(sessionId: string, ordinal: number, epoch?: string): string {
  const prefix = sessionTurnPrefixOf(sessionId);

  return epoch === undefined ? `${prefix}${ordinal}` : `${prefix}${epoch}:${ordinal}`;
}

export function turnId(unit: AcquiredUnit): string {
  return unitTurnId(unit.sessionId, unit.ordinal);
}

/**
 * Builds the core turn; files with no net change (write then revert) are left out. One
 * time allowance is shared by all patches of the unit; spending it throws
 * `PatchBudgetExceededError` rather than yielding a partial turn.
 */
export function toTurn(unit: AcquiredUnit, options: TurnOptions = {}): Turn {
  const files: TurnFile[] = [];
  const deadlineMs = Date.now() + (options.patchBudgetMs ?? DEFAULT_PATCH_BUDGET_MS);

  for (const file of unit.files) {
    const patch = buildFilePatch(file, deadlineMs);

    if (patch !== "") files.push({ path: file.path, patch });
  }

  return { id: options.turnId ?? turnId(unit), task: encodeTask(unit.prompts), files };
}
