import type { OpenCodeMessageInfo, OpenCodeMessageRecord } from "./types";

export function findCompletedAssistant(
  records: readonly OpenCodeMessageRecord[],
): OpenCodeMessageInfo | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];

    if (record !== undefined && isCompletedAssistant(record.info)) {
      return record.info;
    }
  }

  return null;
}

/**
 * Returns the assistant's direct parent user message, or `null` when it is
 * missing from the window or is not a user message.
 */
export function findDirectParentRecord(
  records: readonly OpenCodeMessageRecord[],
  assistant: OpenCodeMessageInfo,
): OpenCodeMessageRecord | null {
  const parentID = assistant.parentID;

  if (typeof parentID !== "string" || parentID === "") {
    return null;
  }

  const record = records.find((item) => item.info.id === parentID);

  if (record === undefined || record.info.role !== "user") {
    return null;
  }

  return record;
}

function isCompletedAssistant(info: OpenCodeMessageInfo): boolean {
  if (info.role !== "assistant") {
    return false;
  }

  if (typeof info.parentID !== "string" || info.parentID === "") {
    return false;
  }

  if (info.error !== undefined && info.error !== null) {
    return false;
  }

  if (info.summary === true) {
    return false;
  }

  return Number.isFinite(info.time?.completed);
}
