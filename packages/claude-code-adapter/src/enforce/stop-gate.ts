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
  /** What is left of the hook's own allowance, in milliseconds. */
  readonly remainingBudgetMs: () => number;
  readonly report: (code: EnforceGateLogCode) => void;
}

/**
 * The `Stop` gate (ADR 0022): returns the one decision to print, or `null` for no
 * decision at all. It reads the user's configuration first — off is silent — then the
 * host's own session flag, then the guards that fail open (an active background task, a
 * continued stop, a unit already blocked). Only then does it wait, at most `budget_ms`
 * and never past the hook's own allowance, for the review the worker records for this
 * unit. A review that does not settle, a dead worker and an absent handoff all end the
 * turn with no decision. The unit is remembered as blocked only after a block is built.
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
