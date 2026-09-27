import type { OpencodeClient } from "@opencode-ai/sdk";
import type { ProposalPromptInput, ProposalSessionFacade } from "./types";

/**
 * Concrete proposal facade over the OpenCode SDK session API. The SDK resolves
 * `{ data, error }` instead of throwing, so absent data or an error payload is
 * rejected and left for the plugin orchestration to contain. The child session is
 * created under the originating session, and the prompt carries the controlled
 * system prompt, the explicit agent, wildcard-disabled tools, and — when configured —
 * an explicit model; `null` omits the model so the host applies its own default.
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
      const model = input.model;

      const result = await client.session.prompt({
        path: { id: input.sessionID },
        body: {
          agent: input.agent,
          ...(model === null
            ? {}
            : { model: { providerID: model.providerID, modelID: model.modelID } }),
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
