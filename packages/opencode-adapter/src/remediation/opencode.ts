import type { OpencodeClient } from "@opencode-ai/sdk";
import type { ProposalPromptInput, ProposalSessionFacade } from "./types";

/**
 * Concrete proposal facade over the OpenCode SDK session API. The SDK resolves
 * `{ data, error }` instead of throwing, so absent data or an error payload is
 * rejected and left for the plugin orchestration to contain. The child session is
 * created under the originating session, and the prompt carries the controlled
 * system prompt, the explicit agent and model, and wildcard-disabled tools.
 */
export function createOpenCodeProposalSessionFacade(client: OpencodeClient): ProposalSessionFacade {
  return {
    async createChildSession(input): Promise<string> {
      const result = await client.session.create({
        body: { parentID: input.parentID, title: input.title },
      });

      if (result.data === undefined || result.error !== undefined) {
        throw new Error("OpenCode child session unavailable");
      }

      return result.data.id;
    },

    async prompt(input: ProposalPromptInput): Promise<void> {
      const result = await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          agent: input.agent,
          model: { providerID: input.model.providerID, modelID: input.model.modelID },
          system: input.system,
          tools: { ...input.tools },
          parts: [{ type: "text", text: input.text }],
        },
      });

      if (result.data === undefined || result.error !== undefined) {
        throw new Error("OpenCode proposal prompt unavailable");
      }
    },
  };
}
