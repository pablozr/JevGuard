import { describeAge } from "../feedback/messages";
import type { AckCandidate, AckListResult, AckResult } from "./types";

export const ACK_USAGE = ["Usage: jevguard ack", "       jevguard ack <number>"].join("\n");

export const ACK_FAILURE_MESSAGE = "Could not complete the ack command.";

export const ACK_NOT_INTERACTIVE_MESSAGE =
  "jevguard ack only runs in an interactive terminal; an agent shell cannot acknowledge a unit.";

const EMPTY_LIST_MESSAGE = "No units waiting to be acknowledged.";
const RULES_SEPARATOR = " + ";

type ListedResult = Extract<AckListResult, { status: "LISTED" }>;
type ErrorResult = Exclude<AckResult, { status: "RECORDED" }>;

/** Human-readable listing: number, blocking rule IDs, unit code and age only. */
export function describeAckList(result: ListedResult, now: Date): string {
  const [first] = result.items;

  if (first === undefined) {
    return EMPTY_LIST_MESSAGE;
  }

  const lines = result.items.map((item) => describeItem(item, now));
  const truncation =
    result.total > result.items.length
      ? [
          `Showing ${result.items.length} of ${result.total}; the rest keep their numbers and can still be acknowledged.`,
        ]
      : [];

  return [
    "Units a FAIL could block (newest first):",
    ...lines,
    ...truncation,
    "",
    "Acknowledge one with:",
    `  jevguard ack ${first.number}`,
  ].join("\n");
}

/** Confirmation naming the unit code and the blocking rules; never rule text or a path. */
export function ackConfirmationMessage(candidate: AckCandidate): string {
  return `Acknowledge unit ${candidate.turnId} (${candidate.ruleIds.join(RULES_SEPARATOR)})? The gate will not block it again.`;
}

/** Result line after the ledger write. */
export function describeAckRecorded(result: Extract<AckResult, { status: "RECORDED" }>): string {
  return `Acknowledged unit ${result.turnId} (${result.ruleIds.join(RULES_SEPARATOR)}). The gate will not block it again.`;
}

export function describeAckError(status: ErrorResult["status"]): string {
  switch (status) {
    case "DECLINED":
      return "Nothing acknowledged.";
    case "NUMBER_OUT_OF_RANGE":
      return "No unit has that number in the current listing. Run `jevguard ack` to list again.";
    case "NOT_INTERACTIVE":
      return ACK_NOT_INTERACTIVE_MESSAGE;
    case "READ_FAILED":
      return "Could not read the local review history or acknowledgement ledger.";
    case "WRITE_FAILED":
      return "Could not save the acknowledgement; nothing was recorded. Check the JevGuard data directory and try again.";
  }
}

function describeItem(item: AckCandidate, now: Date): string {
  return `  ${item.number}  ${item.ruleIds.join(RULES_SEPARATOR)}  ${item.turnId}  (${describeAge(item.timestamp, now)})`;
}
