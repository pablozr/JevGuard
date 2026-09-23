import type { OpencodeClient } from "@opencode-ai/sdk";
import type { BridgeCommandDelivery, OpenCodeCommandClient, ReviewBridgePort } from "./types";

/**
 * Adapts the concrete OpenCode client to the narrow bridge command surface. Typing
 * the parameter as the SDK client keeps compilation pinned to the supported OpenCode
 * SDK version and to the exact `executeCommand` request shape.
 */
export function createOpenCodeCommandClient(client: OpencodeClient): OpenCodeCommandClient {
  return {
    tui: {
      executeCommand: (input) => client.tui.executeCommand({ body: input.body }),
    },
  };
}

/**
 * Review bridge port over the OpenCode TUI command channel. Only the internal command
 * string crosses the boundary; an SDK error payload or a rejected request collapses to
 * `FAILED` and never throws, so the caller's review and presentation are unaffected.
 * No payload, diff, or secret is logged here.
 */
export function createOpenCodeReviewBridge(client: OpenCodeCommandClient): ReviewBridgePort {
  return {
    async execute(command: string): Promise<BridgeCommandDelivery> {
      try {
        const result = await client.tui.executeCommand({ body: { command } });

        return result.error === undefined ? "DELIVERED" : "FAILED";
      } catch {
        return "FAILED";
      }
    },
  };
}
