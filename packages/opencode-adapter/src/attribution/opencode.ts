import type { OpencodeClient } from "@opencode-ai/sdk";
import type { OpenCodeFileDiff, OpenCodeMessageRecord, OpenCodeSessionFacade } from "./types";

/**
 * Concrete read-only facade over the OpenCode SDK session API. The SDK resolves
 * `{ data, error }` instead of throwing, so absent data or an error payload is
 * rejected and left for `attributeTurn` to map to a typed `UNAVAILABLE`. The
 * diff query forwards the supplied message ID verbatim; attribution supplies the
 * parent user message ID, not the assistant message ID.
 */
export function createOpenCodeSessionFacade(client: OpencodeClient): OpenCodeSessionFacade {
  return {
    async listMessages(input): Promise<readonly OpenCodeMessageRecord[]> {
      const result = await client.session.messages({ path: { id: input.sessionID } });

      if (result.data === undefined || result.error !== undefined) {
        throw new Error("OpenCode session messages unavailable");
      }

      return result.data;
    },

    async fetchDiff(input): Promise<readonly OpenCodeFileDiff[]> {
      const result = await client.session.diff({
        path: { id: input.sessionID },
        query: { messageID: input.messageID },
      });

      if (result.data === undefined || result.error !== undefined) {
        throw new Error("OpenCode session diff unavailable");
      }

      return result.data;
    },
  };
}
