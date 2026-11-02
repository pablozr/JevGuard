import {
  buildProposalText,
  parseModelSpecifier,
  PROPOSER_AGENT_PROMPT,
  type RemediationProposalRequest,
  type RemediationProposalStore,
} from "@jevguard/core";
import type {
  ProposalFailureReason,
  ProposalModel,
  ProposalSessionFacade,
  ProposalSessionNavigator,
  RemediationFailureLogSink,
  RemediationNotifier,
} from "@jevguard/opencode-adapter";
import type { ChildExecutionWatcher } from "./child-executions";

const PROPOSAL_SESSION_TITLE = "JevGuard remediation proposal";

/** Time budget for one proposer child execution before it is interrupted. */
export const PROPOSAL_TIMEOUT_MS = 120_000;

export interface ProposalDependencies {
  readonly proposals: RemediationProposalStore;
  readonly proposalFacade: ProposalSessionFacade;
  readonly navigator: ProposalSessionNavigator;
  readonly notifier: RemediationNotifier;
  readonly failures: RemediationFailureLogSink;
  readonly childExecutions: ChildExecutionWatcher;
  readonly proposalTimeoutMs: number;
}

/**
 * Creates at most one automatic proposal for an evaluated turn (OpenCode 2.2.x).
 *
 * - The evaluation identity is claimed before any session call, so a duplicate review
 *   cannot create a second proposal.
 * - The model is explicit: the configured specifier wins, otherwise the originating
 *   session's model. With no readable model, no child is created and the typed
 *   `REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL` is logged.
 * - The child is created with deny-all permissions and no agent, and registered before
 *   the prompt so its own executions are never reviewed. The proposer contract leads
 *   the prompt text.
 * - The child execution is awaited through its lifecycle events; past the time budget
 *   it is interrupted and `REMEDIATION_PROPOSAL_TIMEOUT` is reported.
 *
 * Every failure is a safe typed log plus a generic toast, each contained; nothing
 * reaches the originating review or session.
 */
export async function proposeForTurn(
  request: RemediationProposalRequest | null,
  dependencies: ProposalDependencies,
): Promise<void> {
  if (request === null) {
    return;
  }

  const configured = request.model === null ? null : parseModelSpecifier(request.model);

  if (request.model !== null && configured === null) {
    await reportProposalFailure("MODEL_SPECIFIER_INVALID", dependencies);
    return;
  }

  if (!dependencies.proposals.claim(request.evaluationId)) {
    return;
  }

  const model =
    configured ?? (await readOriginModel(dependencies.proposalFacade, request.sessionID));

  if (model === null) {
    await contain(() => dependencies.failures.write("REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL"));
    return;
  }

  let sessionID: string;

  try {
    sessionID = await dependencies.proposalFacade.createChildSession({
      parentID: request.sessionID,
      title: PROPOSAL_SESSION_TITLE,
      model,
    });
  } catch {
    await reportProposalFailure("CHILD_SESSION_FAILED", dependencies);
    return;
  }

  dependencies.proposals.registerChildSession(sessionID);

  await contain(() => dependencies.navigator.navigate(sessionID));
  await contain(() => dependencies.notifier.proposalPreparing());

  const outcome = dependencies.childExecutions.wait(sessionID, dependencies.proposalTimeoutMs);

  try {
    await dependencies.proposalFacade.prompt({
      sessionID,
      text: `${PROPOSER_AGENT_PROMPT}\n\n${buildProposalText(request)}`,
    });
  } catch {
    // Release the waiter and its timer: the child never ran.
    dependencies.childExecutions.settle(sessionID, "ENDED");
    await outcome;
    await reportProposalFailure("PROPOSAL_PROMPT_FAILED", dependencies);
    return;
  }

  switch (await outcome) {
    case "SUCCEEDED":
      await contain(() => dependencies.notifier.proposalReady());
      return;
    case "ENDED":
      await reportProposalFailure("PROPOSAL_PROMPT_FAILED", dependencies);
      return;
    case "TIMEOUT":
      await contain(() => dependencies.proposalFacade.interrupt(sessionID));
      await reportProposalFailure("REMEDIATION_PROPOSAL_TIMEOUT", dependencies);
      return;
  }
}

async function readOriginModel(
  facade: ProposalSessionFacade,
  sessionID: string,
): Promise<ProposalModel | null> {
  try {
    return await facade.originModel(sessionID);
  } catch {
    return null;
  }
}

async function reportProposalFailure(
  reason: ProposalFailureReason,
  dependencies: ProposalDependencies,
): Promise<void> {
  await contain(() => dependencies.failures.write(reason));
  await contain(() => dependencies.notifier.proposalFailed());
}

async function contain(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    return;
  }
}
