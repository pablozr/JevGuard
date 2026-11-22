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
  const [history, acks] = await Promise.all([deps.history.readStrict(), deps.acks.read()]);

  if (history.status === "FAILED" || acks.status === "FAILED") {
    return { status: "READ_FAILED" };
  }

  const acknowledged = new Set(acks.records.map((record) => record.turnId));
  const units = blockedUnits(history.records).filter((unit) => !acknowledged.has(unit.turnId));

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

  const listed = await listAckCandidates(deps);

  if (listed.status === "READ_FAILED") {
    return { status: "READ_FAILED" };
  }

  const target: AckCandidate | undefined = listed.items.find((item) => item.number === number);

  if (target === undefined) {
    return { status: "NUMBER_OUT_OF_RANGE" };
  }

  const confirmation = await deps.confirm(ackConfirmationMessage(target));

  if (confirmation.status !== "CONFIRMED") {
    return { status: "DECLINED" };
  }

  const written = await deps.acks.append({
    turnId: target.turnId,
    ruleIds: target.ruleIds,
    timestamp: deps.now().toISOString(),
  });

  if (written === "FAILED") {
    return { status: "WRITE_FAILED" };
  }

  return { status: "RECORDED", turnId: target.turnId, ruleIds: target.ruleIds };
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
