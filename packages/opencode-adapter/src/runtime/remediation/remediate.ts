import { decideAgentDelivery, formatAgentDelivery } from "@jevguard/core";
import type { OperationalEvent } from "../../index";
import { contain, proposeForTurn, proposeStrategy } from "./propose";
import type { RemediateDependencies, ReviewedTurn } from "./types";

/** How long a delivery waits for the origin session to go idle before it gives up. */
export const DELIVERY_IDLE_WAIT_MS = 120_000;

/**
 * Handles one reviewed turn with a finding after the user opted into `delivery: agent`:
 * at most one visible message to the agent, built from every finding plus the proposer
 * strategy, or from the findings alone when the proposer failed or no proposal could be
 * requested (oversized or blocked evidence).
 *
 * - A turn that came from a delivery, or a session at its limit, only gets the proposal in
 *   a child session as in observe; the limit also logs `SESSION_LIMIT`.
 * - The delivery is reserved before the proposer runs and counted only when the host
 *   accepted it. It waits for the session to be idle, and gives up after
 *   `DELIVERY_IDLE_WAIT_MS` without queueing anything.
 */
export async function deliverOnce(
  reviewed: ReviewedTurn,
  dependencies: RemediateDependencies,
): Promise<void> {
  const { request, findings, sessionID, turn } = reviewed;
  const { ledger, originPrompt } = dependencies.remediation;
  const decision = decideAgentDelivery({
    agentOptIn: true,
    fromDelivery: reviewed.delivery.fromDelivery,
    deliveredInSession: ledger.used(sessionID),
  });

  if (decision !== "DELIVER" || !ledger.reserve(sessionID)) {
    if (decision !== "PANEL") {
      await writeEvent(
        { kind: "REMEDIATION_NOT_SENT", unitId: turn.id, code: "SESSION_LIMIT" },
        dependencies,
      );
    }

    if (request !== null) await proposeForTurn(request, dependencies);

    return;
  }

  let settled = false;

  try {
    if (!dependencies.proposals.claim(turn.id)) return;

    const strategy = request === null ? null : await proposeStrategy(request, dependencies);
    const text = formatAgentDelivery({
      unit: turn.id,
      findings: findings.findings,
      omitted: findings.omitted,
      strategyText: strategy,
    });

    if ((await dependencies.idle.untilIdle(sessionID, DELIVERY_IDLE_WAIT_MS)) === "TIMEOUT") {
      await writeEvent(notSent(turn.id, "SESSION_BUSY_TIMEOUT"), dependencies);

      return;
    }

    const outcome = await originPrompt.promptVisible(sessionID, text, { v: 1, unitId: turn.id });

    if (outcome === "FAILED") {
      await writeEvent(notSent(turn.id, "HOST_REJECTED"), dependencies);

      return;
    }

    ledger.commit(sessionID);
    settled = true;
    await writeEvent(
      {
        kind: "REMEDIATION_SENT",
        unitId: turn.id,
        strategy: strategy === null ? "FINDINGS_ONLY" : "PROPOSAL",
      },
      dependencies,
    );
  } finally {
    if (!settled) ledger.release(sessionID);
  }
}

function notSent(
  unitId: string,
  cause: "SESSION_BUSY_TIMEOUT" | "HOST_REJECTED",
): OperationalEvent {
  return { kind: "REMEDIATION_NOT_SENT", unitId, code: "DELIVERY_FAILED", cause };
}

function writeEvent(
  event: OperationalEvent,
  dependencies: Pick<RemediateDependencies, "operational">,
): Promise<void> {
  return contain(() => dependencies.operational.write(event));
}
