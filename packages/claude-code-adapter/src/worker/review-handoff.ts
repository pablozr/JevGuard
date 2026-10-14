import type { JevEvaluationPort, Turn, TurnReview } from "@jevguard/core";
import {
  aggregateReview,
  buildProposalRequest,
  DEFAULT_EVIDENCE_POLICY,
  evaluateBuiltIns,
  reviewTurn,
  unavailableReview,
} from "@jevguard/core";
import type { ClaudeReviewHandoff } from "../capture/types";
import type {
  ResolvedReview,
  ReviewedHandoff,
  ReviewHandoffOptions,
  WorkerDependencies,
} from "./types";

function withoutProposal(review: TurnReview): ResolvedReview {
  return { review, proposal: null, projectModelIgnored: false };
}

export const DEFAULT_REVIEW_DEADLINE_MS = 120_000;

function unreachableJev(): never {
  throw new Error("a unit without an attributed patch never reaches Jev");
}

const NO_JEV: JevEvaluationPort = {
  evaluate: unreachableJev,
  evaluateRuleBatch: unreachableJev,
};

/**
 * A unit without a patch has no policy dependency: only the built-in lane reports it,
 * as `SKIPPED/NO_ATTRIBUTED_PATCH`, so a missing or invalid `.jev` never turns it into
 * `UNAVAILABLE` and neither policy nor Jev is touched.
 */
async function skippedReview(turnId: string): Promise<TurnReview> {
  const turn: Turn = { id: turnId, task: "", files: [] };
  const { scopeCreep, complexity } = await evaluateBuiltIns(
    { turn, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
    { jev: NO_JEV },
  );

  return aggregateReview(turnId, [scopeCreep, complexity]);
}

async function reviewResolution(
  handoff: ClaudeReviewHandoff,
  dependencies: WorkerDependencies,
  options: ReviewHandoffOptions,
): Promise<ResolvedReview> {
  const { resolution } = handoff;

  if (resolution.status === "UNAVAILABLE") {
    return withoutProposal(unavailableReview(handoff.turnId, resolution.reason));
  }

  if (resolution.status === "SKIPPED") return withoutProposal(await skippedReview(handoff.turnId));

  const outcome = await reviewTurn(resolution.turn, {
    policy: dependencies.policyFor(handoff.projectRoot),
    parseConfig: dependencies.parseConfig,
    jev: dependencies.jevFor(),
  });

  if (!options.proposals || outcome.remediation.status !== "VALID") {
    return withoutProposal(outcome.review);
  }

  const { config } = outcome.remediation;
  const proposal = buildProposalRequest({
    turn: resolution.turn,
    sessionID: handoff.sessionId,
    rules: outcome.rules,
    results: outcome.review.results,
    config,
  });

  return {
    review: outcome.review,
    proposal,
    projectModelIgnored: proposal !== null && config.model !== null,
  };
}

/**
 * Reviews one handoff. When proposals are enabled, a complete, safe review with a `FAIL`
 * also yields the core's proposal request. Every failure, including a spent deadline,
 * degrades to a review-level `UNAVAILABLE/JEV_FAILURE` with no proposal, so the unit is
 * still recorded.
 */
export async function reviewHandoff(
  handoff: ClaudeReviewHandoff,
  dependencies: WorkerDependencies,
  options: ReviewHandoffOptions,
): Promise<ReviewedHandoff> {
  const failure = withoutProposal(unavailableReview(handoff.turnId, "JEV_FAILURE"));
  const work = reviewResolution(handoff, dependencies, options).catch(() => failure);
  const limit = dependencies.reviewDeadlineMs ?? DEFAULT_REVIEW_DEADLINE_MS;
  const result = await dependencies.deadline.race(work, limit);

  if (result.status === "DEADLINE") return { ...failure, deadlineExceeded: true };

  return { ...result.value, deadlineExceeded: false };
}
