import type { ChainOutcomeIds, ChainState, ChainStep, ChainStopCode } from "./chain";
import { unresolvedIds } from "./chain";

/** A chain that ended outside a review (a delivery did not happen, or its state expired). */
export interface ChainClosure {
  readonly state: ChainState;
  readonly code: ChainStopCode;
}

/** A saved chain whose state aged out or was dropped to make room: nothing counts as fixed. */
export function expiredClosure(state: ChainState): ChainClosure {
  return { state, code: "EXPIRED" };
}

/** One ended chain as a host logs it: ids, counts, hashes and the typed result; never text. */
export interface ChainEndRecord {
  readonly chainId: string;
  readonly turnIds: readonly string[];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly signatures: readonly string[];
  readonly originIds: readonly string[];
  readonly resolvedIds: readonly string[];
  readonly remainingIds: readonly string[];
  readonly result: ChainStopCode | "RESOLVED";
}

/** Where a host sends chains that ended outside a review: a log line, then one record. */
export interface ChainEndSink {
  stopped(code: ChainStopCode, entry: ChainEndRecord): void | Promise<void>;
  record(entry: ChainEndRecord): Promise<void>;
}

function endRecord(
  state: ChainState,
  maxAttempts: number,
  result: ChainEndRecord["result"],
  ids: ChainOutcomeIds,
  turnIds: readonly string[],
): ChainEndRecord {
  return {
    chainId: state.chainId,
    turnIds,
    attempts: state.attempts,
    maxAttempts,
    signatures: state.signatures,
    originIds: state.originIds,
    resolvedIds: ids.resolvedIds,
    remainingIds: ids.remainingIds,
    result,
  };
}

/**
 * The record of a chain a review ended (`STOP` or `RESOLVED`). The reviewed turn joins
 * the chain's turns when the step did not already add it.
 */
export function chainEndOf(
  step: Extract<ChainStep, { kind: "STOP" | "RESOLVED" }>,
  turnId: string,
): ChainEndRecord {
  const { state } = step;
  const turnIds = state.turnIds.includes(turnId) ? state.turnIds : [...state.turnIds, turnId];

  return endRecord(
    state,
    step.maxAttempts,
    step.kind === "STOP" ? step.code : "RESOLVED",
    step.ids,
    turnIds,
  );
}

/**
 * Records the chains that ended outside a review. Nothing about them counts as fixed, and
 * the bound is never below the attempts the chain already made.
 */
export async function recordClosures(
  closures: readonly ChainClosure[],
  maxAttempts: number,
  sink: ChainEndSink,
): Promise<void> {
  for (const { state, code } of closures) {
    const entry = endRecord(
      state,
      Math.max(maxAttempts, state.attempts),
      code,
      unresolvedIds(state),
      state.turnIds,
    );

    await sink.stopped(code, entry);
    await sink.record(entry);
  }
}
