import type { DeliveryFindings, RemediationProposalRequest, Turn } from "@jevguard/core";
import type {
  OperationalLogSink,
  OriginSessionPromptFacade,
  TurnDelivery,
} from "@jevguard/opencode-adapter";
import type { ProposalDependencies } from "./propose";

/**
 * Agent deliveries one plugin process counts per session. A delivery is reserved before
 * the proposer runs and only counted once the host accepted it, so a rejected or timed-out
 * delivery never uses up the session allowance, and parallel reviews of one session
 * cannot overshoot the limit.
 */
export interface DeliveryLedger {
  /** Deliveries counted plus reserved for `sessionID`. */
  used(sessionID: string): number;
  /** Reserves one delivery; `false`, and nothing reserved, at the limit. */
  reserve(sessionID: string): boolean;
  /** Turns a reservation into a counted delivery. */
  commit(sessionID: string): void;
  /** Gives a reservation back. */
  release(sessionID: string): void;
}

export type IdleOutcome = "IDLE" | "TIMEOUT";

/** Waits for a session to have no execution in progress. */
export interface SessionIdleWaiter {
  untilIdle(sessionID: string, timeoutMs: number): Promise<IdleOutcome>;
  /** Called by the runtime when a session's last open execution ended. */
  notifyIdle(sessionID: string): void;
}

/** What `deliverOnce` needs once the user's file opted into `delivery: agent`. */
export interface RemediateSetup {
  readonly originPrompt: OriginSessionPromptFacade;
  readonly ledger: DeliveryLedger;
}

export interface RemediateDependencies extends ProposalDependencies {
  readonly remediation: RemediateSetup;
  readonly operational: OperationalLogSink;
  readonly idle: SessionIdleWaiter;
}

/**
 * One reviewed turn with at least one finding, as the delivery decision needs it. The
 * `request` is `null` when no proposal can be drafted (oversized or blocked evidence, a
 * long task); the findings are delivered either way.
 */
export interface ReviewedTurn {
  readonly turn: Turn;
  readonly sessionID: string;
  readonly delivery: TurnDelivery;
  readonly request: RemediationProposalRequest | null;
  readonly findings: DeliveryFindings;
}
