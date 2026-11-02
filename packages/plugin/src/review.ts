import {
  buildProposalRequest,
  type RemediationProposalRequest,
  reviewTurn,
  type Turn,
  type TurnReviewOutcome,
} from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/node-infra";
import type { TurnDelivery } from "@jevguard/opencode-adapter";
import { presentReview } from "./present";
import { proposeForTurn } from "./remediation/propose";
import { remediateTurn } from "./remediation/remediate";
import type { ReviewDependencies } from "./types";

/**
 * Reviews one attributed turn: run the core review, present exactly one aggregate, and
 * then build one aggregate proposal request for the whole turn when the project's `.jev`
 * allows it.
 *
 * - `remediate` (the user's file opted in): the core's chain decision may queue one
 *   visible remediation message into the originating session.
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

  const request = buildAggregateRequest(turn, sessionID, outcome);

  if (dependencies.remediation === null) {
    await proposeForTurn(request, dependencies);
    return;
  }

  await remediateTurn(
    { turn, sessionID, delivery, request, results: outcome.review.results },
    { ...dependencies, remediation: dependencies.remediation },
  );
}

function buildAggregateRequest(
  turn: Turn,
  sessionID: string,
  outcome: TurnReviewOutcome,
): RemediationProposalRequest | null {
  if (outcome.remediation.status !== "VALID") {
    return null;
  }

  return buildProposalRequest({
    turn,
    sessionID,
    rules: outcome.rules,
    results: outcome.review.results,
    config: outcome.remediation.config,
  });
}
