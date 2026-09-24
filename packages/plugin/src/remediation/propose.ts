import {
  buildProposalText,
  parseModelSpecifier,
  PROPOSER_AGENT_NAME,
  PROPOSER_AGENT_PROMPT,
  type RemediationProposalRequest,
  type RemediationProposalStore,
} from "@jevguard/core";
import type {
  ProposalSessionFacade,
  ProposalSessionNavigator,
  RemediationNotifier,
} from "@jevguard/opencode-adapter";

const PROPOSAL_SESSION_TITLE = "JevGuard remediation proposal";
const PROPOSER_TOOLS: Readonly<Record<string, boolean>> = { "*": false };

export interface ProposalDependencies {
  readonly proposals: RemediationProposalStore;
  readonly proposalFacade: ProposalSessionFacade;
  readonly navigator: ProposalSessionNavigator;
  readonly notifier: RemediationNotifier;
}

/**
 * Creates at most one automatic proposal for an evaluated turn. The evaluation
 * identity is claimed before any host call, so a duplicate or re-entrant review
 * cannot create a second proposal. The child session is registered immediately after
 * creation, before navigation and the prompt, so its own idle events are excluded
 * from review and can never recurse. The TUI navigates to the child session before
 * the proposer is prompted, so the user's attention moves there while the proposal
 * generates; navigation failure is contained and the prompt still runs. Only after
 * the prompt completes successfully does it notify that the proposal is ready. Every
 * host, model, toast, or navigation failure is contained and never reaches the
 * originating review or its presentation.
 */
export async function proposeForTurn(
  request: RemediationProposalRequest | null,
  dependencies: ProposalDependencies,
): Promise<void> {
  if (request === null) {
    return;
  }

  const model = parseModelSpecifier(request.model);

  if (model === null) {
    return;
  }

  if (!dependencies.proposals.claim(request.evaluationId)) {
    return;
  }

  try {
    const sessionID = await dependencies.proposalFacade.createChildSession({
      parentID: request.sessionID,
      title: PROPOSAL_SESSION_TITLE,
    });

    dependencies.proposals.registerChildSession(sessionID);

    await navigateToProposal(dependencies.navigator, sessionID);
    await notifyProposalPreparing(dependencies.notifier);

    await dependencies.proposalFacade.prompt({
      sessionID,
      agent: PROPOSER_AGENT_NAME,
      model,
      system: PROPOSER_AGENT_PROMPT,
      tools: PROPOSER_TOOLS,
      text: buildProposalText(request),
    });

    await notifyProposalReady(dependencies.notifier);
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
