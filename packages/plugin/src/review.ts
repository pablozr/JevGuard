import {
  buildProposalRequest,
  type RemediationProposalRequest,
  reviewTurn,
  type Turn,
  type TurnReviewOutcome,
} from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/opencode-adapter";
import { presentReview } from "./present";
import { proposeForTurn } from "./remediation/propose";
import type { ReviewDependencies } from "./types";

/**
 * Reviews one attributed turn: run the core review, present exactly one aggregate, and
 * then, when the remediation config is enabled and valid, build one aggregate proposal
 * request for the whole turn and schedule at most one automatic proposal. This review
 * never injects into agent context.
 */
export async function reviewAttributedTurn(
  turn: Turn,
  sessionID: string,
  dependencies: ReviewDependencies,
): Promise<void> {
  const outcome = await reviewTurn(turn, {
    policy: dependencies.policy,
    parseConfig: parsePolicyConfig,
    jev: dependencies.jev,
  });

  await presentReview(dependencies.presenter, outcome.review);

  const request = buildAggregateRequest(turn, sessionID, outcome);

  await proposeForTurn(request, dependencies);
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
