import type { FeedbackRecord } from "@jevguard/core";
import { isObject } from "../history/jsonl-file";

const MAX_FIELD_LENGTH = 1024;
const RECORD_KEY_COUNT = 4;

/** Parses one feedback line; anything that is not exactly the four allowlisted fields is `null`. */
export function parseFeedbackRecord(line: string): FeedbackRecord | null {
  const value = parseJson(line);

  if (!isObject(value) || Object.keys(value).length !== RECORD_KEY_COUNT) {
    return null;
  }

  const { turnId, ruleId, decision, timestamp } = value;

  if (!isBoundedString(turnId) || !isBoundedString(ruleId) || !isBoundedString(timestamp)) {
    return null;
  }

  if ((decision !== "RIGHT" && decision !== "WRONG") || Number.isNaN(Date.parse(timestamp))) {
    return null;
  }

  return { turnId, ruleId, decision, timestamp };
}

/** Serializes only the four allowlisted fields, in order, without the trailing newline. */
export function serializeFeedbackRecord(record: FeedbackRecord): string {
  return JSON.stringify({
    turnId: record.turnId,
    ruleId: record.ruleId,
    decision: record.decision,
    timestamp: record.timestamp,
  });
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_FIELD_LENGTH;
}
