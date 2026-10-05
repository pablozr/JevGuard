import type { JevEvaluationPort, Turn, TurnReview } from "@jevguard/core";
import {
  aggregateReview,
  DEFAULT_EVIDENCE_POLICY,
  evaluateBuiltIns,
  reviewTurn,
  unavailableReview,
} from "@jevguard/core";
import type { ClaudeReviewHandoff } from "../capture/types";
import type { ReviewedHandoff, WorkerDependencies } from "./types";

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
): Promise<TurnReview> {
  const { resolution } = handoff;

  if (resolution.status === "UNAVAILABLE") {
    return unavailableReview(handoff.turnId, resolution.reason);
  }

  if (resolution.status === "SKIPPED") return skippedReview(handoff.turnId);

  const outcome = await reviewTurn(resolution.turn, {
    policy: dependencies.policyFor(handoff.projectRoot),
    parseConfig: dependencies.parseConfig,
    jev: dependencies.jevFor(),
  });

  return outcome.review;
}

/**
 * Reviews one handoff without remediation. Every failure, including a spent deadline,
 * degrades to a review-level `UNAVAILABLE/JEV_FAILURE` so the unit is still recorded.
 */
export async function reviewHandoff(
  handoff: ClaudeReviewHandoff,
  dependencies: WorkerDependencies,
): Promise<ReviewedHandoff> {
  const failure = unavailableReview(handoff.turnId, "JEV_FAILURE");
  const work = reviewResolution(handoff, dependencies).catch(() => failure);
  const limit = dependencies.reviewDeadlineMs ?? DEFAULT_REVIEW_DEADLINE_MS;
  const result = await dependencies.deadline.race(work, limit);

  if (result.status === "DEADLINE") return { review: failure, deadlineExceeded: true };

  return { review: result.value, deadlineExceeded: false };
}
