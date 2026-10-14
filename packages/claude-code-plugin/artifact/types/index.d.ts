/** The last remediation proposal the plugin drafted, as its panel draws it. */
export type JevguardProposal = {
  turnId: string;
  unit: string;
  text: string;
  applyInstruction: string;
  delivery: "user" | "agent";
};

/** Agent deliveries already made, by session id, kept across reloads and resumes. */
export type JevguardAgentDeliveries = Record<string, number>;

declare module "claude-code" {
  interface PluginState {
    jevguard: {
      proposal: JevguardProposal | null;
      agentDeliveries: JevguardAgentDeliveries;
    };
  }
}
