import {
  buildProposalText,
  PROPOSER_AGENT_PROMPT,
  parseModelSpecifier,
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
} from "../../index";
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
 * What one proposer run produced. `SHOWN` is an observe proposal left for the user in its
 * child session; `READY` is the answer of an `agent` run kept in the background.
 */
type ProposalDraft =
  | { readonly status: "SHOWN" }
  | { readonly status: "READY"; readonly text: string }
  | { readonly status: "FAILED" };

/** `observe` opens the child for the user; `agent` keeps it in the background for a delivery. */
type ProposalMode = "observe" | "agent";

const FAILED: ProposalDraft = { status: "FAILED" };

/**
 * Creates at most one automatic proposal for an evaluated turn (OpenCode 2.2.x) and
 * shows it to the user in the child session (observe).
 */
export async function proposeForTurn(
  request: RemediationProposalRequest,
  dependencies: ProposalDependencies,
): Promise<void> {
  if (!dependencies.proposals.claim(request.evaluationId)) {
    return;
  }

  const draft = await draftProposal(request, dependencies, "observe");

  if (draft.status === "SHOWN") {
    await contain(() => dependencies.notifier.proposalReady());
  }
}

/**
 * Runs the proposer in the background for an agent delivery and returns its strategy,
 * or `null` when it failed, timed out or had no model; the typed reason is already
 * logged. The caller has claimed the evaluation.
 */
export async function proposeStrategy(
  request: RemediationProposalRequest,
  dependencies: ProposalDependencies,
): Promise<string | null> {
  const draft = await draftProposal(request, dependencies, "agent");

  return draft.status === "READY" ? draft.text : null;
}

/**
 * Runs the proposer once for an evaluated turn the caller already claimed. In
 * `observe` the child is opened for the user; in `agent` it stays in the background and
 * its answer is returned.
 *
 * - The model is explicit: the configured specifier wins, otherwise the originating
 *   session's model. With no readable model, no child is created and the typed
 *   `REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL` is logged.
 * - The child is created with deny-all permissions and no agent, and registered before
 *   the prompt so its own executions are never reviewed. The proposer contract leads
 *   the prompt text.
 * - The child execution is awaited through its lifecycle events; past the time budget
 *   it is interrupted and `REMEDIATION_PROPOSAL_TIMEOUT` is reported. In `agent`, a
 *   succeeded child's answer is its last assistant text.
 *
 * Every failure is a safe typed log plus a generic toast, each contained; nothing
 * reaches the originating review or session.
 */
async function draftProposal(
  request: RemediationProposalRequest,
  dependencies: ProposalDependencies,
  mode: ProposalMode,
): Promise<ProposalDraft> {
  const configured = request.model === null ? null : parseModelSpecifier(request.model);

  if (request.model !== null && configured === null) {
    await reportProposalFailure("MODEL_SPECIFIER_INVALID", dependencies);
    return FAILED;
  }

  const model =
    configured ?? (await readOriginModel(dependencies.proposalFacade, request.sessionID));

  if (model === null) {
    await contain(() => dependencies.failures.write("REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL"));
    return FAILED;
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
    return FAILED;
  }

  dependencies.proposals.registerChildSession(sessionID);

  if (mode === "observe") {
    await contain(() => dependencies.navigator.navigate(sessionID));
  }

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
    return FAILED;
  }

  switch (await outcome) {
    case "SUCCEEDED":
      return mode === "observe" ? { status: "SHOWN" } : readAnswer(sessionID, dependencies);
    case "ENDED":
      await reportProposalFailure("PROPOSAL_PROMPT_FAILED", dependencies);
      return FAILED;
    case "TIMEOUT":
      await contain(() => dependencies.proposalFacade.interrupt(sessionID));
      await reportProposalFailure("REMEDIATION_PROPOSAL_TIMEOUT", dependencies);
      return FAILED;
  }
}

async function readAnswer(
  sessionID: string,
  dependencies: ProposalDependencies,
): Promise<ProposalDraft> {
  let text: string | null;

  try {
    text = await dependencies.proposalFacade.readProposal(sessionID);
  } catch {
    text = null;
  }

  if (text === null) {
    await reportProposalFailure("PROPOSAL_PROMPT_FAILED", dependencies);
    return FAILED;
  }

  return { status: "READY", text };
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

export async function contain(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch {
    return;
  }
}
