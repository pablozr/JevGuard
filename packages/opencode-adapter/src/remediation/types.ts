/**
 * Model identity for one proposer invocation, already split into the provider and
 * model IDs the host expects.
 */
export interface ProposalModel {
  readonly providerID: string;
  readonly modelID: string;
}

/**
 * One proposer invocation. `system`, `tools`, and `text` are supplied by the plugin
 * from controlled contracts; the host client only transports them. No credential is
 * carried here.
 */
export interface ProposalPromptInput {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: ProposalModel;
  readonly system: string;
  readonly tools: Readonly<Record<string, boolean>>;
  readonly text: string;
}

/**
 * Host port for the automatic proposal. It creates one child session under the
 * originating session and prompts the hidden proposer subagent with no tools. The
 * concrete adapter owns the OpenCode SDK calls and unwraps their results.
 */
export interface ProposalSessionFacade {
  createChildSession(input: { readonly parentID: string; readonly title: string }): Promise<string>;
  prompt(input: ProposalPromptInput): Promise<void>;
}
