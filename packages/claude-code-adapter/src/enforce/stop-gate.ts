import type { EnforceUserSettingsResult } from "@jevguard/node-infra/enforce";
import type { StopEvent } from "../hook-event/types";
import { decideEnforce, toStopOutput } from "./decide";
import { detectSession, type EnforceEnvironment } from "./session";
import type {
  EnforceClosedUnit,
  EnforceGateLogCode,
  EnforceResultFacts,
  EnforceStopOutput,
} from "./types";

/**
 * What the local acknowledgement ledger says about the closing unit. `UNREADABLE` is a
 * ledger that could not be read: the gate then goes on as if the unit were not
 * acknowledged and records the closed code, so a broken ledger never disables enforce.
 */
export type EnforceAckState = "ACKED" | "NOT_ACKED" | "UNREADABLE";

/** One block per unit: the session remembers the unit it blocked. */
export interface EnforceBlockedUnits {
  isBlocked(unit: EnforceClosedUnit): boolean;
  record(unit: EnforceClosedUnit): void;
}

export interface EnforceStopRequest {
  /** The closing `Stop` input; `stop_hook_active` and `background_tasks` are its own. */
  readonly event: StopEvent;
  readonly closed: EnforceClosedUnit;
}

export interface EnforceStopDependencies {
  readonly environment: EnforceEnvironment;
  readonly settingsFor: (projectRoot: string) => EnforceUserSettingsResult;
  /** Waits for the unit's recorded review; `null` when it does not settle in time. */
  readonly waitForReview: (
    turnId: string,
    budgetMs: number,
  ) => Promise<readonly EnforceResultFacts[] | null>;
  readonly blockedUnits: EnforceBlockedUnits;
  /** The local ledger's answer for the unit; it never throws. */
  readonly ackStateFor: (turnId: string) => Promise<EnforceAckState>;
  /** What is left of the hook's own allowance, in milliseconds. */
  readonly remainingBudgetMs: () => number;
  readonly report: (code: EnforceGateLogCode) => void;
}

/**
 * The `Stop` gate (ADR 0022): returns the one decision to print, or `null` for no
 * decision at all. It reads the user's configuration first — off is silent, and a valid
 * section whose effective allowlist is empty (only built-in checks listed) ends here
 * without waiting, since nothing in it could ever block — then the host's own session
 * flag, then the guards that fail open (an active background task, a continued stop, a
 * unit already blocked) and the local acknowledgement ledger — a unit the user
 * acknowledged ends here with `ENFORCE_ACKED`, without waiting. Only then does it wait,
 * at most `budget_ms` and never past the hook's own allowance, for the review the
 * worker records for this unit. A review that does not settle, a dead worker and an
 * absent handoff all end the turn with no decision. The unit is remembered as blocked
 * only after a block is built.
 */
export async function enforceStop(
  request: EnforceStopRequest,
  dependencies: EnforceStopDependencies,
): Promise<EnforceStopOutput | null> {
  const settings = dependencies.settingsFor(request.closed.projectRoot);

  if (settings.status === "INVALID") {
    dependencies.report("ENFORCE_CONFIG_INVALID");

    return null;
  }

  if (settings.status !== "ENABLED") return null;

  // An allowlist of built-in checks only is a valid `ENABLED` section whose effective
  // allowlist is empty: nothing in it can ever block, so the wait would only cost the
  // whole budget for a review that cannot change the outcome.
  if (settings.settings.rules.length === 0) {
    dependencies.report("ENFORCE_NO_ELIGIBLE_RULES");

    return null;
  }

  const session = detectSession(dependencies.environment);

  if (session !== "INTERACTIVE") {
    dependencies.report("ENFORCE_NON_INTERACTIVE");

    return null;
  }

  if (request.event.stopHookActive || dependencies.blockedUnits.isBlocked(request.closed)) {
    dependencies.report("ENFORCE_CAP_REACHED");

    return null;
  }

  if (request.event.backgroundTasks !== "EMPTY") {
    dependencies.report("ENFORCE_BACKGROUND_TASK");

    return null;
  }

  // The user's acknowledgement silences one unit for good: there is nothing to wait for
  // and nothing that could block. An unreadable ledger is reported and treated as no
  // acknowledgement, so a broken local file never turns enforce off by itself.
  const ackState = await dependencies.ackStateFor(request.closed.turnId);

  if (ackState === "ACKED") {
    dependencies.report("ENFORCE_ACKED");

    return null;
  }

  if (ackState === "UNREADABLE") dependencies.report("ENFORCE_ACK_UNREADABLE");

  if (!request.closed.handoffCreated) {
    dependencies.report("ENFORCE_NO_REVIEW");

    return null;
  }

  const budgetMs = Math.min(settings.settings.budgetMs, dependencies.remainingBudgetMs());

  if (budgetMs <= 0) {
    dependencies.report("ENFORCE_TIMEOUT");

    return null;
  }

  const results = await dependencies.waitForReview(request.closed.turnId, budgetMs);

  if (results === null) {
    dependencies.report("ENFORCE_TIMEOUT");

    return null;
  }

  const decision = decideEnforce({
    settings: settings.settings,
    review: { results },
    session,
    backgroundTasks: request.event.backgroundTasks,
    stopHookActive: request.event.stopHookActive,
    unitAlreadyBlocked: false,
    acknowledged: false,
  });

  if (!decision.block) {
    dependencies.report(decision.code);

    return null;
  }

  dependencies.blockedUnits.record(request.closed);
  dependencies.report("ENFORCE_BLOCKED");

  return toStopOutput(decision);
}
