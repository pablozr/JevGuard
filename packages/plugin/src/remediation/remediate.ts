import {
  type ChainClosure,
  type ChainEndRecord,
  type ChainEndSink,
  type ChainStep,
  chainEndOf,
  decideChainStep,
  decideOrphanStep,
  deliveryFindingsOf,
  formatAgentDelivery,
  type RemediationProposalRequest,
  type ReviewResult,
  recordClosures,
  type Turn,
} from "@jevguard/core";
import type { RemediationChainLog } from "@jevguard/node-infra";
import type {
  OperationalEvent,
  OperationalLogSink,
  OriginSessionPromptFacade,
  TurnDelivery,
} from "@jevguard/opencode-adapter";
import type { RemediationChains } from "./chains";
import { contain, draftProposal, type ProposalDependencies } from "./propose";

/** Longest proposer answer carried into a delivery; the rest is dropped. */
export const MAX_STRATEGY_TEXT_LENGTH = 32_768;

/** What `remediate` needs once the user's file opted in; absent otherwise. */
export interface RemediateSetup {
  readonly originPrompt: OriginSessionPromptFacade;
  readonly maxAttempts: number;
  readonly chains: RemediationChains;
  readonly chainLog: RemediationChainLog;
}

export interface RemediateDependencies extends ProposalDependencies {
  readonly remediation: RemediateSetup;
  readonly operational: OperationalLogSink;
  /** `true` while the session runs another execution, so nothing may be queued into it. */
  readonly isBusy: (sessionID: string) => boolean;
}

/** One reviewed turn, as the chain decision needs it. */
export interface ReviewedTurn {
  readonly turn: Turn;
  readonly sessionID: string;
  readonly delivery: TurnDelivery;
  readonly request: RemediationProposalRequest | null;
  readonly results: readonly ReviewResult[];
}

/**
 * Runs the core's chain decision for one reviewed turn in `remediate` and acts on it.
 *
 * - The chain mark is read only from the synthetic message's metadata; a turn that mixes a
 *   marked delivery with a user message cannot be judged, so its chain ends as unverified.
 * - `DELIVER` runs the proposer in the background and queues one visible synthetic message
 *   into the originating session, never while that session runs another execution. The
 *   session limit, a failed proposer, a busy session and a rejected message each end the
 *   chain with a typed code; no model leaves the strategy empty.
 * - `STOP` and `RESOLVED` log one line and one chain record.
 */
export async function remediateTurn(
  reviewed: ReviewedTurn,
  dependencies: RemediateDependencies,
): Promise<void> {
  const step = chainStepOf(reviewed, dependencies.remediation);

  switch (step.kind) {
    case "NONE":
      return;
    case "STOP":
    case "RESOLVED":
      await endChain(chainEndOf(step, reviewed.turn.id), dependencies);
      return;
    case "DELIVER":
      // The core only decides `DELIVER` from a request.
      if (reviewed.request === null) return;
      await deliver(step, reviewed, reviewed.request, dependencies);
      return;
  }
}

/**
 * Ends the session's saved chain as unverified after an execution that has no turn of its
 * own (interrupted, failed, or not attributable): it cannot judge the chain.
 */
export async function endOrphanChain(
  sessionID: string,
  dependencies: Pick<RemediateDependencies, "remediation" | "operational">,
): Promise<void> {
  const { chains, maxAttempts } = dependencies.remediation;
  const active = chains.activeChain(sessionID);

  if (active === null) return;

  const step = decideOrphanStep(active, maxAttempts, "remediate");

  if (step.kind === "STOP") {
    await closeChains([{ state: step.state, code: step.code }], dependencies);
  }
}

function chainStepOf(reviewed: ReviewedTurn, setup: RemediateSetup): ChainStep {
  const { mark, mixed } = reviewed.delivery;
  const chain = mark === null ? null : setup.chains.load(mark.chainId);

  if (mixed && chain !== null) return decideOrphanStep(chain, setup.maxAttempts, "remediate");

  return decideChainStep({
    mode: "remediate",
    maxAttempts: setup.maxAttempts,
    delivery: mark,
    chain,
    request: mixed ? null : reviewed.request,
    results: reviewed.results,
    turnId: reviewed.turn.id,
  });
}

async function deliver(
  step: Extract<ChainStep, { kind: "DELIVER" }>,
  reviewed: ReviewedTurn,
  request: RemediationProposalRequest,
  dependencies: RemediateDependencies,
): Promise<void> {
  const { chains, originPrompt } = dependencies.remediation;
  const { sessionID } = reviewed;
  const end = (code: ChainClosure["code"]) =>
    closeChains([{ state: step.state, code }], dependencies);

  if (!chains.countDelivery(sessionID)) {
    await end("SESSION_LIMIT");
    return;
  }

  const draft = await draftProposal(request, dependencies, "remediate");

  if (draft.status === "DUPLICATE") return;

  if (draft.status === "FAILED") {
    await end("PROPOSAL_FAILED");
    return;
  }

  if (dependencies.isBusy(sessionID)) {
    await end("UNVERIFIED");
    return;
  }

  await closeChains(chains.save(sessionID, step.state), dependencies);

  const mark = { chainId: step.chainId, attempt: step.attempt, maxAttempts: step.maxAttempts };
  const text = formatAgentDelivery({
    unit: `turn ${reviewed.turn.id}`,
    ...mark,
    findings: deliveryFindingsOf(request),
    strategyText: draft.status === "READY" ? draft.text.slice(0, MAX_STRATEGY_TEXT_LENGTH) : "",
  });

  try {
    await originPrompt.promptVisible(sessionID, text, mark);
  } catch {
    await end("DELIVERY_FAILED");
    return;
  }

  await writeEvent({ kind: "REMEDIATION_SENT", ...mark }, dependencies);
}

function closeChains(
  closures: readonly ChainClosure[],
  dependencies: Pick<RemediateDependencies, "remediation" | "operational">,
): Promise<void> {
  const { remediation } = dependencies;

  for (const closure of closures) {
    remediation.chains.remove(closure.state.chainId);
  }

  return recordClosures(closures, remediation.maxAttempts, endSinkOf(dependencies));
}

async function endChain(
  entry: ChainEndRecord,
  dependencies: Pick<RemediateDependencies, "remediation" | "operational">,
): Promise<void> {
  dependencies.remediation.chains.remove(entry.chainId);
  await writeEvent(endEventOf(entry), dependencies);
  await recordEnd(entry, dependencies);
}

function endSinkOf(
  dependencies: Pick<RemediateDependencies, "remediation" | "operational">,
): ChainEndSink {
  return {
    stopped: (_code, entry) => writeEvent(endEventOf(entry), dependencies),
    record: (entry) => recordEnd(entry, dependencies),
  };
}

function recordEnd(
  entry: ChainEndRecord,
  dependencies: Pick<RemediateDependencies, "remediation">,
): Promise<void> {
  return dependencies.remediation.chainLog.record({ host: "opencode", ...entry });
}

function endEventOf(entry: ChainEndRecord): OperationalEvent {
  return entry.result === "RESOLVED"
    ? {
        kind: "REMEDIATION_RESOLVED",
        chainId: entry.chainId,
        fixed: entry.resolvedIds.length,
        attempts: entry.attempts,
      }
    : {
        kind: "REMEDIATION_STOPPED",
        chainId: entry.chainId,
        attempt: entry.attempts,
        maxAttempts: entry.maxAttempts,
        code: entry.result,
      };
}

function writeEvent(
  event: OperationalEvent,
  dependencies: Pick<RemediateDependencies, "operational">,
): Promise<void> {
  return contain(() => dependencies.operational.write(event));
}
