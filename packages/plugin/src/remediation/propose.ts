import {
  buildProposalText,
  parseModelSpecifier,
  PROPOSER_AGENT_NAME,
  PROPOSER_AGENT_PROMPT,
  type RemediationProposalRequest,
  type RemediationProposalStore,
} from "@jevguard/core";
import type {
  ProposalFailureReason,
  ProposalSessionFacade,
  ProposalSessionNavigator,
  RemediationFailureLogSink,
  RemediationNotifier,
} from "@jevguard/opencode-adapter";

const PROPOSAL_SESSION_TITLE = "JevGuard remediation proposal";
const PROPOSER_TOOLS: Readonly<Record<string, boolean>> = { "*": false };

export interface ProposalDependencies {
  readonly proposals: RemediationProposalStore;
  readonly proposalFacade: ProposalSessionFacade;
  readonly navigator: ProposalSessionNavigator;
  readonly notifier: RemediationNotifier;
  readonly failures: RemediationFailureLogSink;
}

/**
 * Creates at most one automatic proposal for an evaluated turn. The evaluation
 * identity is claimed before any host call, so a duplicate or re-entrant review
 * cannot create a second proposal. The child session is registered immediately after
 * creation, before navigation and the prompt, so its own idle events are excluded
 * from review and can never recurse. The TUI navigates to the child session before
 * the proposer is prompted, so the user's attention moves there while the proposal
 * generates; navigation failure is contained, is not a proposal failure, and the
 * prompt still runs. A `null` request model inherits the host model; a present model
 * is parsed and a malformed specifier is a typed proposal failure. A child-session or
 * prompt failure is reported as a safe failure log plus a generic failure toast, each
 * individually contained; the preparing/ready toast failures stay silent. A reported
 * proposal failure never reaches the originating review or its presentation.
 */
export async function proposeForTurn(
  request: RemediationProposalRequest | null,
  dependencies: ProposalDependencies,
): Promise<void> {
  if (request === null) {
    return;
  }

  const model = request.model === null ? null : parseModelSpecifier(request.model);

  if (request.model !== null && model === null) {
    await reportProposalFailure("MODEL_SPECIFIER_INVALID", dependencies);
    return;
  }

  if (!dependencies.proposals.claim(request.evaluationId)) {
    return;
  }

  let sessionID: string;

  try {
    sessionID = await dependencies.proposalFacade.createChildSession({
      parentID: request.sessionID,
      title: PROPOSAL_SESSION_TITLE,
    });
  } catch {
    await reportProposalFailure("CHILD_SESSION_FAILED", dependencies);
    return;
  }

  dependencies.proposals.registerChildSession(sessionID);

  await navigateToProposal(dependencies.navigator, sessionID);
  await notifyProposalPreparing(dependencies.notifier);

  try {
    await dependencies.proposalFacade.prompt({
      sessionID,
      agent: PROPOSER_AGENT_NAME,
      model,
      system: PROPOSER_AGENT_PROMPT,
      tools: PROPOSER_TOOLS,
      text: buildProposalText(request),
    });
  } catch {
    await reportProposalFailure("PROPOSAL_PROMPT_FAILED", dependencies);
    return;
  }

  await notifyProposalReady(dependencies.notifier);
}

async function reportProposalFailure(
  reason: ProposalFailureReason,
  dependencies: ProposalDependencies,
): Promise<void> {
  await writeFailureLog(dependencies.failures, reason);
  await notifyProposalFailed(dependencies.notifier);
}

async function writeFailureLog(
  sink: RemediationFailureLogSink,
  reason: ProposalFailureReason,
): Promise<void> {
  try {
    await sink.write(reason);
  } catch {
    return;
  }
}

async function notifyProposalFailed(notifier: RemediationNotifier): Promise<void> {
  try {
    await notifier.proposalFailed();
  } catch {
    return;
  }
}

async function notifyProposalPreparing(notifier: RemediationNotifier): Promise<void> {
  try {
    await notifier.proposalPreparing();
  } catch {
    return;
  }
}

async function notifyProposalReady(notifier: RemediationNotifier): Promise<void> {
  try {
    await notifier.proposalReady();
  } catch {
    return;
  }
}

async function navigateToProposal(
  navigator: ProposalSessionNavigator,
  sessionID: string,
): Promise<void> {
  try {
    await navigator.navigate(sessionID);
  } catch {
    return;
  }
}
