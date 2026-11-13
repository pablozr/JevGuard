import type { FeedbackDecision } from "@jevguard/core";
import type { FeedbackListItem, FeedbackListResult, FeedbackMarkResult } from "./types";

export const FEEDBACK_USAGE = [
  "Usage: jevguard feedback [--json]",
  "       jevguard feedback <number> <right|wrong>",
].join("\n");

export const FEEDBACK_INVALID_DECISION_MESSAGE =
  "The answer must be right (a real violation) or wrong (a false alarm).";

export const FEEDBACK_FAILURE_MESSAGE = "Could not complete the feedback command.";

const EMPTY_LIST_MESSAGE = "No unanswered FAILs.";
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const TWO_DAYS_MS = 48 * HOUR_MS;
const DAY_MS = 24 * HOUR_MS;

type ListedResult = Extract<FeedbackListResult, { status: "LISTED" }>;
type FeedbackErrorResult = Exclude<FeedbackMarkResult, { status: "RECORDED" | "UNCHANGED" }>;

export function describeAge(timestamp: string, now: Date): string {
  const elapsed = now.getTime() - Date.parse(timestamp);

  if (Number.isNaN(elapsed) || elapsed < MINUTE_MS) {
    return "just now";
  }

  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  }

  if (elapsed < TWO_DAYS_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  }

  return `${Math.floor(elapsed / DAY_MS)} d ago`;
}

/** Human-readable listing: numbered rule IDs, ages, and probabilities only. */
export function describeFeedbackList(result: ListedResult, now: Date): string {
  const [first] = result.items;

  if (first === undefined) {
    return EMPTY_LIST_MESSAGE;
  }

  const width = Math.max(...result.items.map((item) => item.ruleId.length));
  const lines = result.items.map((item) => describeItem(item, width, now));
  const truncation =
    result.total > result.items.length
      ? [`Showing ${result.items.length} of ${result.total}.`]
      : [];

  return [
    "Unanswered FAILs (newest first):",
    ...lines,
    ...truncation,
    "",
    "Answer with:",
    `  jevguard feedback ${first.number} wrong   (false alarm)`,
    `  jevguard feedback ${first.number} right   (real violation)`,
  ].join("\n");
}

export function serializeFeedbackList(result: ListedResult): string {
  return JSON.stringify(
    { version: 1, listedAt: result.listedAt, total: result.total, items: result.items },
    null,
    2,
  );
}

/** Confirmation naming the rule, age, and probability the listing showed for the FAIL. */
export function describeFeedbackMark(
  result: Extract<FeedbackMarkResult, { status: "RECORDED" | "UNCHANGED" }>,
  now: Date,
): string {
  const age = describeAge(result.timestamp, now);
  const subject = `${result.ruleId} (${age}, p=${result.violationProbability.toFixed(2)})`;
  const verdict = describeVerdict(result.decision);

  if (result.status === "UNCHANGED") {
    return `Already marked as ${verdict}: ${subject}.`;
  }

  if (result.previous === null) {
    return `Marked as ${verdict}: ${subject}.`;
  }

  return `Changed to ${verdict}: ${subject} (was ${describeVerdict(result.previous)}).`;
}

export function describeFeedbackError(status: FeedbackErrorResult["status"]): string {
  switch (status) {
    case "NO_SELECTION":
      return "Run `jevguard feedback` first to list the unanswered FAILs.";
    case "NUMBER_OUT_OF_RANGE":
      return "No FAIL has that number in the last list. Run `jevguard feedback` to list them again.";
    case "NO_LONGER_IN_HISTORY":
      return "That FAIL is no longer in the review history. Run `jevguard feedback` to list them again.";
    case "READ_FAILED":
      return "Could not read the local review history or feedback.";
    case "WRITE_FAILED":
      return "Could not save the feedback. Check the permissions of the JevGuard data directory.";
  }
}

function describeItem(item: FeedbackListItem, width: number, now: Date): string {
  const age = describeAge(item.timestamp, now);

  return `  ${item.number}  ${item.ruleId.padEnd(width)}  ${age}  p=${item.violationProbability.toFixed(2)}`;
}

function describeVerdict(decision: FeedbackDecision): string {
  return decision === "WRONG" ? "a false alarm" : "a real violation";
}
