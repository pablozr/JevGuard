import type { Plugin } from "@opencode/plugin";
import type { ProposalModel, ProposalSessionFacade } from "./types";

/** The slice of the 2.2.x plugin context the proposal facade uses. */
export interface ProposalContext {
  readonly session: Pick<
    Plugin.Context["session"],
    "get" | "create" | "prompt" | "interrupt" | "hook"
  >;
}

/** Denies every permission in the proposer child session: no tools, no edits. */
export const PROPOSER_PERMISSIONS = [{ action: "*", resource: "*", effect: "deny" }] as const;

/**
 * Concrete proposal facade over the OpenCode 2.2.x session API. `originModel` reads
 * the originating session's model; `createChildSession` passes that model explicitly
 * with the deny-all ruleset and no agent; `prompt` sends text only.
 */
export function createOpenCodeProposalSessionFacade(
  context: ProposalContext,
): ProposalSessionFacade {
  return {
    async originModel(sessionID): Promise<ProposalModel | null> {
      const session = await context.session.get({ sessionID });
      const model = session.model;

      return model === undefined ? null : { providerID: model.providerID, modelID: model.id };
    },

    async createChildSession(input): Promise<string> {
      const session = await context.session.create({
        parentID: input.parentID,
        title: input.title,
        model: { providerID: input.model.providerID, id: input.model.modelID },
        permissions: PROPOSER_PERMISSIONS.map((rule) => ({ ...rule })),
      });

      return session.id;
    },

    async prompt(input): Promise<void> {
      await context.session.prompt({ sessionID: input.sessionID, text: input.text });
    },

    async interrupt(sessionID): Promise<void> {
      await context.session.interrupt({ sessionID });
    },
  };
}

/**
 * Stops the host from retrying a failed model call inside a proposer child session,
 * so an unavailable model cannot retry forever. Other sessions are left untouched.
 */
export function registerProposalRetryGuard(
  context: ProposalContext,
  isChildSession: (sessionID: string) => boolean,
): Promise<{ readonly dispose: () => Promise<void> }> {
  return context.session.hook("retry", (retry) => {
    if (isChildSession(retry.sessionID)) {
      retry.decision = { retry: false };
    }
  });
}
