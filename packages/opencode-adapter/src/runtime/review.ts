import {
  buildProposalRequest,
  collectDeliveryFindings,
  type RemediationConfig,
  proposesOnFail,
  reviewTurn,
  type Turn,
  type TurnReviewOutcome,
} from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/node-infra";
import type { TurnDelivery } from "../index";
import { presentReview } from "./present";
import { proposeForTurn } from "./remediation/propose";
import { deliverOnce } from "./remediation/remediate";
import type { ReviewDependencies } from "./types";

/**
 * Reviews one attributed turn: run the core review, present exactly one aggregate, and
 * then act on its `FAIL` findings when the project's `.jev` allows remediation.
 *
 * - `delivery: agent` (the user's file opted in): at most one visible message with every
 *   finding, and the strategy when a proposal could be requested, is queued into the
 *   originating session.
 * - Otherwise (observe): at most one automatic proposal in a child session; nothing
 *   reaches the agent's context.
 */
export async function reviewAttributedTurn(
  turn: Turn,
  sessionID: string,
  delivery: TurnDelivery,
  dependencies: ReviewDependencies,
): Promise<void> {
  const outcome = await reviewTurn(turn, {
    policy: dependencies.policy,
    parseConfig: parsePolicyConfig,
    jev: dependencies.jev,
  });

  await presentReview(dependencies.presenter, outcome.review);

  const config = remediationConfigOf(outcome);

  if (config === null) {
    return;
  }

  const findings = collectDeliveryFindings({
    turn,
    rules: outcome.rules,
    results: outcome.review.results,
  });

  if (findings.findings.length === 0) {
    return;
  }

  const request = buildProposalRequest({
    turn,
    sessionID,
    rules: outcome.rules,
    results: outcome.review.results,
    config,
  });
  const { remediation } = dependencies;

  if (remediation !== null) {
    await deliverOnce(
      { turn, sessionID, delivery, request, findings },
      { ...dependencies, remediation },
    );
  } else if (request !== null) {
    await proposeForTurn(request, dependencies);
  }
}

function remediationConfigOf(outcome: TurnReviewOutcome): RemediationConfig | null {
  if (outcome.remediation.status !== "VALID") {
    return null;
  }

  return proposesOnFail(outcome.remediation.config) ? outcome.remediation.config : null;
}
