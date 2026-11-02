import type { ChainClosure, ChainOutcomeIds, ChainState, ChainStep } from "@jevguard/core";
import {
  abandonDeliver,
  chainIdsOf,
  decideChainStep,
  decideOrphanStep,
  parseAutoDelivery,
  recordClosures as recordChainClosures,
} from "@jevguard/core";
import type { ClaudeReviewHandoff } from "../../capture/types";
import type { ReviewFeedChain } from "../../presentation";
import type { ReviewedHandoff, WorkerDependencies } from "../types";
import type { ChainDelivery } from "./request-file";
import { fitsChainRequest } from "./request-file";
import type { ClaudeRemediationSettingsResult } from "./types";

function isRemediate(
  settings: ClaudeRemediationSettingsResult,
): settings is Extract<ClaudeRemediationSettingsResult, { status: "ENABLED" }> {
  return settings.status === "ENABLED" && settings.settings.mode === "remediate";
}

/**
 * In `remediate`, drops a proposal request whose findings do not fit what the mod accepts,
 * so nothing is sent and the decision sees incomplete evidence: a chain in progress stops as
 * unverified and none starts. The findings are never truncated to make them fit.
 */
export function withinChainLimits(
  reviewed: ReviewedHandoff,
  settings: ClaudeRemediationSettingsResult,
  dependencies: WorkerDependencies,
): ReviewedHandoff {
  if (!isRemediate(settings) || reviewed.proposal === null || fitsChainRequest(reviewed.proposal)) {
    return reviewed;
  }

  dependencies.log("PROPOSAL_REQUEST_TOO_LARGE");

  return { ...reviewed, proposal: null };
}

/**
 * What the core's chain decision says about one reviewed unit. `observe`, a disabled
 * remediation and a unit with no chain behind it are always `NONE`, so only a user who opted
 * into `remediate` ever reaches the chain. A unit with no turn (skipped, unavailable) has no
 * task to carry the mark, so it belongs to the session's saved chain and can only end it as
 * unverified.
 */
export function chainStepOf(
  handoff: ClaudeReviewHandoff,
  reviewed: ReviewedHandoff,
  settings: ClaudeRemediationSettingsResult,
  dependencies: WorkerDependencies,
): ChainStep {
  const none: ChainStep = { kind: "NONE" };

  if (!isRemediate(settings)) return none;

  if (handoff.resolution.status !== "TURN") {
    const active = dependencies.proposals.activeChain(handoff);

    return active === null ? none : decideOrphanStep(active, settings.settings.maxAttempts);
  }

  const delivery = parseAutoDelivery(handoff.resolution.turn.task);
  const chain =
    delivery === null || delivery === "LEGACY"
      ? null
      : dependencies.proposals.loadChain(handoff, delivery.chainId);

  return decideChainStep({
    mode: settings.settings.mode,
    maxAttempts: settings.settings.maxAttempts,
    delivery,
    chain,
    request: reviewed.proposal,
    results: reviewed.review.results,
    turnId: handoff.turnId,
  });
}

/** The chain data a `DELIVER` step puts on the proposal request. */
export function deliveryOf(step: ChainStep): ChainDelivery | undefined {
  return step.kind === "DELIVER"
    ? { chainId: step.chainId, attempt: step.attempt, maxAttempts: step.maxAttempts }
    : undefined;
}

function fixedCount(state: ChainState, reviewed: ReviewedHandoff): number {
  return chainIdsOf(state, reviewed.review.results).resolvedIds.length;
}

async function recordEnd(
  state: ChainState,
  maxAttempts: number,
  result: string,
  ids: ChainOutcomeIds,
  turnIds: readonly string[],
  dependencies: WorkerDependencies,
): Promise<void> {
  await dependencies.chainLog.record({
    host: "claude-code",
    chainId: state.chainId,
    turnIds,
    attempts: state.attempts,
    maxAttempts,
    signatures: state.signatures,
    originIds: state.originIds,
    resolvedIds: ids.resolvedIds,
    remainingIds: ids.remainingIds,
    result,
  });
}

/**
 * Records the chains that ended outside a review (the mod reported that a delivery did not
 * happen, or the state expired), through the core's shared rule.
 */
export async function recordClosures(
  closures: readonly ChainClosure[],
  maxAttempts: number,
  dependencies: WorkerDependencies,
): Promise<void> {
  await recordChainClosures(closures, maxAttempts, {
    stopped: (code) => dependencies.log(`CHAIN_STOPPED:${code}`),
    record: (entry) => dependencies.chainLog.record({ host: "claude-code", ...entry }),
  });
}

async function endChain(
  step: Extract<ChainStep, { kind: "STOP" | "RESOLVED" }>,
  handoff: ClaudeReviewHandoff,
  dependencies: WorkerDependencies,
): Promise<ReviewFeedChain> {
  const { state, ids } = step;
  const result = step.kind === "STOP" ? step.code : "RESOLVED";
  // A state can hold more attempts than the configured limit (the user lowered it, or the
  // mark was forged); the feed rejects attempt > maxAttempts, so report the larger.
  const maxAttempts = Math.max(step.maxAttempts, state.attempts);
  const turnIds = state.turnIds.includes(handoff.turnId)
    ? state.turnIds
    : [...state.turnIds, handoff.turnId];

  dependencies.proposals.removeChain(handoff, state.chainId);
  dependencies.log(step.kind === "STOP" ? `CHAIN_STOPPED:${step.code}` : "CHAIN_RESOLVED");

  await recordEnd(state, maxAttempts, result, ids, turnIds, dependencies);

  return {
    chainId: state.chainId,
    attempt: state.attempts,
    maxAttempts,
    result,
    fixed: ids.resolvedIds.length,
  };
}

/**
 * A delivery that could not happen (the request was not written, or its state was not
 * saved) leaves no chain behind: a continuation ends as `DELIVERY_FAILED` with what it had
 * resolved before, and a first attempt has no saved state to end.
 */
async function abandonDelivery(
  step: Extract<ChainStep, { kind: "DELIVER" }>,
  handoff: ClaudeReviewHandoff,
  reviewed: ReviewedHandoff,
  dependencies: WorkerDependencies,
): Promise<ReviewFeedChain | undefined> {
  const stop = abandonDeliver(step, reviewed.review.results);

  return stop === null ? undefined : endChain(stop, handoff, dependencies);
}

export interface SettledChain {
  /** The chain data for the feed record; `undefined` for a unit outside a chain. */
  readonly chain: ReviewFeedChain | undefined;
  /** Whether a request is waiting for the mod; `false` when the delivery was abandoned. */
  readonly proposed: boolean;
}

/**
 * Settles the chain after the request was (or was not) written: an ended chain drops its
 * state and is logged; a delivery saves its state and tells the feed it is in flight, and a
 * delivery whose request or state could not be written is withdrawn and ends the chain.
 */
export async function settleChain(
  step: ChainStep,
  handoff: ClaudeReviewHandoff,
  reviewed: ReviewedHandoff,
  proposed: boolean,
  dependencies: WorkerDependencies,
): Promise<SettledChain> {
  if (step.kind === "STOP" || step.kind === "RESOLVED") {
    return { chain: await endChain(step, handoff, dependencies), proposed: false };
  }

  if (step.kind !== "DELIVER") return { chain: undefined, proposed };

  if (proposed && dependencies.proposals.saveChain(handoff, step.state)) {
    dependencies.log("CHAIN_DELIVERING");

    return {
      chain: {
        chainId: step.chainId,
        attempt: step.attempt,
        maxAttempts: step.maxAttempts,
        result: "DELIVERING",
        fixed: fixedCount(step.state, reviewed),
      },
      proposed: true,
    };
  }

  if (proposed) {
    dependencies.log("CHAIN_STATE_SAVE_FAILED");
    dependencies.proposals.remove(handoff);
  }

  return { chain: await abandonDelivery(step, handoff, reviewed, dependencies), proposed: false };
}
