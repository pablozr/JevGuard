import type { EnforceUserSettings } from "@jevguard/node-infra/enforce";
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

/**
 * Every closed code the `Stop` gate can leave in the hook log: the no-block decisions
 * plus its own outcomes. None of them carries a rule ID, a path, a task or a credential.
 */
export type EnforceGateLogCode =
  | EnforceNoBlockCode
  | "ENFORCE_BLOCKED"
  | "ENFORCE_TIMEOUT"
  | "ENFORCE_NO_REVIEW"
  | "ENFORCE_CONFIG_INVALID"
  | "ENFORCE_GATE_FAILED"
  | "ENFORCE_OUTPUT_FAILED"
  | "STATE_WRITE_FAILED";

/**
 * The result fields the gate reads, and nothing else. A full review result and the
 * projected local-history record both satisfy it, so the gate never needs the patch,
 * the task or a path to decide.
 */
export interface EnforceResultFacts {
  readonly kind: "RULE" | "BUILT_IN" | "REVIEW";
  readonly ruleId: string | null;
  readonly severity: "error" | "warning" | null;
  readonly outcome: "PASS" | "WARN" | "FAIL" | "UNAVAILABLE" | "SKIPPED";
}

/** The unit a closing `Stop` produced; the only thing the gate needs from the hook. */
export interface EnforceClosedUnit {
  readonly sessionId: string;
  readonly sessionDirectory: string;
  readonly turnId: string;
  readonly projectRoot: string;
  readonly epoch: string;
  readonly ordinal: number;
  /** `true` when the handoff was written, so a review can actually be recorded. */
  readonly handoffCreated: boolean;
}

export interface EnforceInput {
  readonly settings: EnforceUserSettings;
  /** The review of the closing unit; only its results are read. */
  readonly review: { readonly results: readonly EnforceResultFacts[] };
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
