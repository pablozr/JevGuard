import {
  createConfirmationPrompt,
  createLocalEnforceAckStore,
  createLocalReviewHistory,
  createNodeReviewHistoryFileSystem,
  createProcessReviewHistoryContext,
} from "@jevguard/node-infra";
import { listAckCandidates, recordAck } from "./execute";
import type { AckListResult, AckResult, ProcessAckDependencies } from "./types";

/** Lists the blocked units from the real local review history and ledger. */
export function performAckList(): Promise<AckListResult> {
  return listAckCandidates(createProcessAckDependencies());
}

/** Acknowledges one unit against the real local review history and ledger. */
export function performAck(number: number): Promise<AckResult> {
  return recordAck(number, createProcessAckDependencies());
}

/** Wires the real local review history, the ledger and the terminal confirmation. */
export function createProcessAckDependencies(): ProcessAckDependencies {
  const context = createProcessReviewHistoryContext();
  const fileSystem = createNodeReviewHistoryFileSystem();
  const now = () => new Date();

  return {
    history: createLocalReviewHistory({ context, fileSystem, now }),
    acks: createLocalEnforceAckStore({ context, fileSystem }),
    now,
    isInteractiveTerminal: () => process.stdin.isTTY === true && process.stdout.isTTY === true,
    confirm: (message) => createConfirmationPrompt().confirm(message),
  };
}
