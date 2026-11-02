import type { DeliveryMark } from "../attribution/types";

/**
 * Model identity for one proposer invocation, already split into the provider and
 * model IDs the host expects.
 */
export interface ProposalModel {
  readonly providerID: string;
  readonly modelID: string;
}

/**
 * Host port for the automatic proposal (OpenCode 2.2.x). There is no proposer agent:
 * the child session is created under the originating session with an explicit model
 * and a deny-all permission ruleset, and the proposer contract travels at the start
 * of the prompt text. `interrupt` stops a child that ran too long. Every method rejects
 * on a host failure; the plugin orchestration contains it.
 */
export interface ProposalSessionFacade {
  originModel(sessionID: string): Promise<ProposalModel | null>;
  createChildSession(input: {
    readonly parentID: string;
    readonly title: string;
    readonly model: ProposalModel;
  }): Promise<string>;
  prompt(input: { readonly sessionID: string; readonly text: string }): Promise<void>;
  /**
   * The proposer's answer once its execution succeeded: the text parts of the last
   * assistant message of the child session, or `null` when it has none.
   */
  readProposal(sessionID: string): Promise<string | null>;
  interrupt(sessionID: string): Promise<void>;
}

/**
 * Sends one remediation message to the originating session (OpenCode 2.2.x): a visible
 * synthetic message, queued behind any running execution, tagged with the chain mark.
 * It rejects on a host failure; the plugin orchestration contains it.
 */
export interface OriginSessionPromptFacade {
  promptVisible(sessionID: string, text: string, mark: DeliveryMark): Promise<void>;
}
