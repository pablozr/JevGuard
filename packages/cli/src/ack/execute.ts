import { MAX_ACK_RULE_IDS } from "@jevguard/node-infra";
import type { ReviewHistoryRecord } from "@jevguard/node-infra";
import { ackConfirmationMessage } from "./messages";
import type { AckCandidate, AckDependencies, AckListResult, AckResult } from "./types";

/** How many blocked units one listing shows; the total is still reported. */
export const ACK_LIST_LIMIT = 10;

interface BlockedUnit {
  readonly turnId: string;
  readonly ruleIds: readonly string[];
  readonly timestamp: string;
}

/**
 * Lists the units the gate could block, newest first and numbered from the local review
 * history: a unit qualifies when one of its `error`-severity rule results is `FAIL`.
 * Units already in the acknowledgement ledger are left out — they are silenced.
 */
export async function listAckCandidates(deps: AckDependencies): Promise<AckListResult> {
  const units = await candidateUnits(deps);

  if (units === null) {
    return { status: "READ_FAILED" };
  }

  return {
    status: "LISTED",
    total: units.length,
    items: units.slice(0, ACK_LIST_LIMIT).map((unit, index) => ({ number: index + 1, ...unit })),
  };
}

/**
 * Acknowledges the unit at `number` from the current listing. Only an interactive
 * terminal gets this far, and only an explicit confirmation records it; the ledger
 * keeps the unit code, the blocking rule IDs and the timestamp, nothing else.
 */
export async function recordAck(number: number, deps: AckDependencies): Promise<AckResult> {
  if (!deps.isInteractiveTerminal()) {
    return { status: "NOT_INTERACTIVE" };
  }

  // Numbers resolve over every candidate, not only the displayed slice, so a unit past
  // `ACK_LIST_LIMIT` can still be acknowledged by its number in the listing.
  const units = await candidateUnits(deps);

  if (units === null) {
    return { status: "READ_FAILED" };
  }

  const target = units[number - 1];

  if (target === undefined) {
    return { status: "NUMBER_OUT_OF_RANGE" };
  }

  const candidate: AckCandidate = { number, ...target };
  const confirmation = await deps.confirm(ackConfirmationMessage(candidate));

  if (confirmation.status !== "CONFIRMED") {
    return { status: "DECLINED" };
  }

  // The ledger keeps at most `MAX_ACK_RULE_IDS` IDs per line, the same bound its reader
  // applies; a unit with more is recorded with the first ones, never a line the next
  // read would skip.
  const ruleIds = target.ruleIds.slice(0, MAX_ACK_RULE_IDS);
  const written = await deps.acks.append({
    turnId: target.turnId,
    ruleIds,
    timestamp: deps.now().toISOString(),
  });

  if (written === "FAILED") {
    return { status: "WRITE_FAILED" };
  }

  return { status: "RECORDED", turnId: target.turnId, ruleIds };
}

/**
 * Every unit a block could affect, newest first and numbered from 1 by position; `null`
 * when the history or the ledger cannot be read.
 */
async function candidateUnits(deps: AckDependencies): Promise<readonly BlockedUnit[] | null> {
  const [history, acks] = await Promise.all([deps.history.readStrict(), deps.acks.read()]);

  if (history.status === "FAILED" || acks.status === "FAILED") {
    return null;
  }

  const acknowledged = new Set(acks.records.map((record) => record.turnId));

  return blockedUnits(history.records).filter((unit) => !acknowledged.has(unit.turnId));
}

/** Newest first: the history appends in order, so the reversed pass starts at the end. */
function blockedUnits(records: readonly ReviewHistoryRecord[]): readonly BlockedUnit[] {
  const units: BlockedUnit[] = [];
  const seen = new Set<string>();

  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];

    if (record === undefined || seen.has(record.turnId)) continue;

    const ruleIds = errorFails(record);

    if (ruleIds.length === 0) continue;

    seen.add(record.turnId);
    units.push({ turnId: record.turnId, ruleIds, timestamp: record.timestamp });
  }

  return units;
}

function errorFails(record: ReviewHistoryRecord): readonly string[] {
  const ruleIds: string[] = [];

  for (const result of record.results) {
    if (
      result.kind === "RULE" &&
      result.severity === "error" &&
      result.outcome === "FAIL" &&
      result.ruleId !== null
    ) {
      ruleIds.push(result.ruleId);
    }
  }

  return ruleIds;
}
