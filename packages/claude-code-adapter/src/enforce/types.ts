import type { TurnReview } from "@jevguard/core";
import type { EnforceUserSettings } from "@jevguard/node-infra";
import type { BackgroundTasksState } from "../hook-event/types";

/**
 * Whether the host positively identified an interactive session. `UNKNOWN` is not a
 * guess: a session that cannot be positively classified is treated as non-interactive
 * and never blocks (ADR 0022, decision 4).
 */
export type EnforceSession = "INTERACTIVE" | "NON_INTERACTIVE" | "UNKNOWN";

/** Why a turn was not blocked; a closed code, safe to log. */
export type EnforceNoBlockCode =
  | "ENFORCE_NO_ELIGIBLE_RULES"
  | "ENFORCE_NON_INTERACTIVE"
  | "ENFORCE_BACKGROUND_TASK"
  | "ENFORCE_CAP_REACHED"
  | "ENFORCE_ACKED"
  | "ENFORCE_NO_FAIL";

export interface EnforceInput {
  readonly settings: EnforceUserSettings;
  /** The review of the closing unit; only its results are read. */
  readonly review: Pick<TurnReview, "results">;
  readonly session: EnforceSession;
  /** Read from the `Stop` input, never inferred (ADR 0022, decision 3). */
  readonly backgroundTasks: BackgroundTasksState;
  /** `stop_hook_active` from the `Stop` input. */
  readonly stopHookActive: boolean;
  /** The hook's own per-unit guard: this unit was already blocked once. */
  readonly unitAlreadyBlocked: boolean;
  /** The unit is in the user's acknowledgement ledger. */
  readonly acknowledged: boolean;
}

export type EnforceDecision =
  | { readonly block: false; readonly code: EnforceNoBlockCode }
  | {
      readonly block: true;
      /** The blocking allowlisted rules, in configured order. */
      readonly ruleIds: readonly string[];
      /** Built only from rule IDs; never rule text, diff, task, path or credential. */
      readonly reason: string;
    };

/** The JSON a `Stop` hook writes to hold the turn; `null` means no decision at all. */
export interface EnforceStopOutput {
  readonly decision: "block";
  readonly reason: string;
}
