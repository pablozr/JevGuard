import type { Turn, TurnFile } from "@jevguard/core";
import { findCompletedAssistant, findDirectParentRecord } from "./locate-turn";
import { normalizeFileDiff } from "./normalize-patch";
import { extractTask } from "./task";
import type {
  AttributeTurnDependencies,
  AttributionFailureReason,
  OpenCodeFileDiff,
  OpenCodeMessageRecord,
  OpenCodeSessionFacade,
  TurnAttribution,
} from "./types";

/**
 * Maps one idle session reaction into a core `Turn`. The diff is fetched with the
 * V1.18.31 parent user message ID, the assistant message ID is the turn/dedupe
 * identity, and failures are never marked so the caller can retry. Repeated idle
 * for an already attributed assistant returns `ALREADY_PROCESSED`.
 */
export async function attributeTurn(
  sessionID: string,
  dependencies: AttributeTurnDependencies,
): Promise<TurnAttribution> {
  const facade = dependencies.facade;
  const deduplicator = dependencies.deduplicator;

  const records = await readMessages(facade, sessionID);

  if (records === null) {
    return unavailable("MESSAGE_READ_FAILURE");
  }

  const assistant = findCompletedAssistant(records);

  if (assistant === null) {
    return { status: "NONE" };
  }

  if (deduplicator.hasProcessed(assistant.id)) {
    return { status: "ALREADY_PROCESSED" };
  }

  const parent = findDirectParentRecord(records, assistant);

  if (parent === null) {
    return unavailable("MISSING_PARENT_MESSAGE");
  }

  const task = extractTask(parent.parts);

  if (task === null) {
    return unavailable("EMPTY_TASK");
  }

  const diffs = await readDiff(facade, sessionID, parent.info.id);

  if (diffs === null) {
    return unavailable("DIFF_READ_FAILURE");
  }

  const files = normalizeDiffs(diffs);

  if (files === null) {
    return unavailable("INCOMPLETE_FILE_DIFF");
  }

  deduplicator.markProcessed(assistant.id);

  const turn: Turn = { id: assistant.id, task, files };

  return { status: "ATTRIBUTED", turn };
}

async function readMessages(
  facade: OpenCodeSessionFacade,
  sessionID: string,
): Promise<readonly OpenCodeMessageRecord[] | null> {
  try {
    return await facade.listMessages({ sessionID });
  } catch {
    return null;
  }
}

async function readDiff(
  facade: OpenCodeSessionFacade,
  sessionID: string,
  messageID: string,
): Promise<readonly OpenCodeFileDiff[] | null> {
  try {
    return await facade.fetchDiff({ sessionID, messageID });
  } catch {
    return null;
  }
}

function normalizeDiffs(diffs: readonly OpenCodeFileDiff[]): readonly TurnFile[] | null {
  const files: TurnFile[] = [];

  for (const diff of diffs) {
    const result = normalizeFileDiff(diff);

    if (result.status === "INCOMPLETE") {
      return null;
    }

    if (result.status === "PATCH") {
      files.push(result.file);
    }
  }

  return files;
}

function unavailable(reason: AttributionFailureReason): TurnAttribution {
  return { status: "UNAVAILABLE", reason };
}
