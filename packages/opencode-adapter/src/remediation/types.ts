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
  interrupt(sessionID: string): Promise<void>;
}
