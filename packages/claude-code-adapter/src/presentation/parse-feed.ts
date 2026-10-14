import type { OperationalStatus, ReviewCounts, SemanticVerdict } from "@jevguard/core";
import { TURN_ID_PREFIX } from "./turn-id";
import type { ReviewFeedLane, ReviewFeedLine, ReviewFeedRecorded, ReviewFeedResult } from "./types";

const MAX_TURN_ID_LENGTH = 512;
const MAX_RESULTS = 200;
const MAX_CAUSES = 32;
const RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const TYPED_CODE = /^[A-Z][A-Z_]{0,63}$/;

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTypedCode(value: unknown): value is string {
  return typeof value === "string" && TYPED_CODE.test(value);
}

function isLane(value: unknown): value is ReviewFeedLane {
  return value === "RULE" || value === "BUILT_IN" || value === "REVIEW";
}

function isSemantic(value: unknown): value is SemanticVerdict {
  return value === "PASS" || value === "WARN" || value === "FAIL";
}

function isOperational(value: unknown): value is OperationalStatus {
  return value === "SKIPPED" || value === "UNAVAILABLE";
}

function turnIdOf(record: JsonRecord): string | null {
  const { turnId } = record;

  return typeof turnId === "string" &&
    turnId.length <= MAX_TURN_ID_LENGTH &&
    turnId.startsWith(TURN_ID_PREFIX)
    ? turnId
    : null;
}

function timestampOf(record: JsonRecord): string | null {
  const { at } = record;

  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}

function countsOf(value: unknown): ReviewCounts | null {
  if (!isRecord(value)) return null;

  const { pass, warn, fail, skipped, unavailable } = value;

  if (
    !isCount(pass) ||
    !isCount(warn) ||
    !isCount(fail) ||
    !isCount(skipped) ||
    !isCount(unavailable)
  ) {
    return null;
  }

  return { pass, warn, fail, skipped, unavailable };
}

function listOf<T>(
  value: unknown,
  max: number,
  parse: (item: unknown) => T | null,
): readonly T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;

  const items: T[] = [];

  for (const item of value) {
    const parsed = parse(item);

    if (parsed === null) return null;

    items.push(parsed);
  }

  return items;
}

function causesOf(value: unknown): readonly string[] | null {
  return listOf(value, MAX_CAUSES, (cause) => (isTypedCode(cause) ? cause : null));
}

function resultOf(value: unknown): ReviewFeedResult | null {
  if (!isRecord(value)) return null;

  const { lane, id, sliceCount, outcome, probability, reason } = value;

  if (!isLane(lane)) return null;
  if (id !== null && !(typeof id === "string" && RESULT_ID.test(id))) return null;
  if (sliceCount !== null && !isCount(sliceCount)) return null;

  const identity = { lane, id, sliceCount };

  if (isSemantic(outcome)) {
    const valid = typeof probability === "number" && probability >= 0 && probability <= 1;

    return valid ? { ...identity, outcome, probability } : null;
  }

  return isOperational(outcome) && isTypedCode(reason) ? { ...identity, outcome, reason } : null;
}

function resultsOf(value: unknown): readonly ReviewFeedResult[] | null {
  return listOf(value, MAX_RESULTS, resultOf);
}

function recordedOf(record: JsonRecord, turnId: string, at: string): ReviewFeedRecorded | null {
  const counts = countsOf(record.counts);
  const causes = causesOf(record.causes);
  const results = resultsOf(record.results);

  if (counts === null || causes === null || results === null) return null;
  if (record.proposal === undefined)
    return { v: 1, kind: "RECORDED", turnId, at, counts, causes, results };
  if (record.proposal !== true) return null;

  return { v: 1, kind: "RECORDED", turnId, at, counts, causes, results, proposal: true };
}

function lineOf(value: unknown): ReviewFeedLine | null {
  if (!isRecord(value) || value.v !== 1) return null;

  const turnId = turnIdOf(value);
  const at = timestampOf(value);

  if (turnId === null || at === null) return null;
  if (value.kind === "STARTED") return { v: 1, kind: "STARTED", turnId, at };

  return value.kind === "RECORDED" ? recordedOf(value, turnId, at) : null;
}

function parseLine(text: string): ReviewFeedLine | null {
  try {
    return lineOf(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Parses a feed file strictly; any invalid line, including a partial last one, is dropped. */
export function parseReviewFeed(text: string): readonly ReviewFeedLine[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => parseLine(line) ?? []);
}
