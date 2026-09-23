import {
  DEFAULT_EVIDENCE_POLICY,
  type ReviewBridgePayload,
  selectTurnEvidence,
  type Turn,
  type TurnFile,
} from "@jevguard/core";
import {
  extractTask,
  findDirectParentRecord,
  isCompletedAssistantMessage,
  normalizeFileDiff,
  type OpenCodeFileDiff,
  type OpenCodeMessageRecord,
} from "@jevguard/opencode-adapter/attribution";
import type { ProposalContext, TuiRead, TuiSessionReader } from "./types";

/**
 * Upper bound on the recovered task text. A longer task rejects the proposal
 * instead of truncating agent context.
 */
export const MAX_TASK_LENGTH = 16_384;

/**
 * Recovers the task and the assistant-attributed patch for one bridge payload using
 * only the session API. The assistant message named by the payload must be a
 * completed turn, its task comes from the direct parent user message, and the diff is
 * fetched with that parent user message ID. There is no repository or global diff
 * fallback: any failed read, incomplete patch, oversized diff, or blocked path
 * returns `FAILED`.
 */
export async function retrieveProposalContext(
  payload: ReviewBridgePayload,
  reader: TuiSessionReader,
): Promise<TuiRead<ProposalContext>> {
  const records = await reader.listMessages(payload.sessionID);

  if (records.status !== "OK") {
    return failed();
  }

  const assistant = findAssistantRecord(records.value, payload.messageID);

  if (assistant === null) {
    return failed();
  }

  const parent = findDirectParentRecord(records.value, assistant.info);

  if (parent === null) {
    return failed();
  }

  const task = extractTask(parent.parts);

  if (task === null || task.length > MAX_TASK_LENGTH) {
    return failed();
  }

  const diffs = await reader.fetchDiff({
    sessionID: payload.sessionID,
    messageID: parent.info.id,
  });

  if (diffs.status !== "OK") {
    return failed();
  }

  const files = normalizeDiffs(diffs.value);

  if (files === null) {
    return failed();
  }

  const turn: Turn = { id: payload.messageID, task, files };
  const selection = selectTurnEvidence(turn, DEFAULT_EVIDENCE_POLICY);

  if (selection.status !== "SELECTED") {
    return failed();
  }

  return {
    status: "OK",
    value: {
      task,
      diff: selection.evidence.diff,
      files: selection.evidence.files,
      rule: payload.rule,
      probability: payload.probability,
    },
  };
}

function findAssistantRecord(
  records: readonly OpenCodeMessageRecord[],
  messageID: string,
): OpenCodeMessageRecord | null {
  const record = records.find((item) => item.info.id === messageID);

  if (record === undefined || !isCompletedAssistantMessage(record.info)) {
    return null;
  }

  return record;
}

function normalizeDiffs(diffs: readonly OpenCodeFileDiff[]): readonly TurnFile[] | null {
  const files: TurnFile[] = [];

  for (const diff of diffs) {
    const normalized = normalizeFileDiff(diff);

    if (normalized.status === "INCOMPLETE") {
      return null;
    }

    if (normalized.status === "PATCH") {
      files.push(normalized.file);
    }
  }

  return files;
}

function failed(): TuiRead<ProposalContext> {
  return { status: "FAILED" };
}
