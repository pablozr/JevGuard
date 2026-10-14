import type { RemediationProposalRequest } from "@jevguard/core";
import { buildProposalText, PROPOSER_AGENT_PROMPT } from "@jevguard/core";
import { ORPHAN_TTL_MS } from "../../capture/unit-state";
import { isAutoDeliveredTask } from "../../presentation";
import type { ClaudeRemediationSettings, EncodedProposalRequest } from "./types";

/**
 * Encodes the core's proposal request exactly as the proposer receives it: the same
 * system prompt and user text. The model is the user's, never the project's, and an
 * `agent` delivery is downgraded to `user` when the unit's task is itself an automatic
 * delivery, so a proposal can never trigger another one.
 */
export function encodeProposalRequestFile(input: {
  readonly request: RemediationProposalRequest;
  readonly settings: ClaudeRemediationSettings;
  readonly turnId: string;
  readonly now: Date;
}): EncodedProposalRequest {
  const { request, settings, turnId, now } = input;
  const downgraded = settings.delivery === "agent" && isAutoDeliveredTask(request.task);

  return {
    file: {
      v: 1,
      kind: "PROPOSAL_REQUEST",
      turnId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ORPHAN_TTL_MS).toISOString(),
      delivery: downgraded ? "user" : settings.delivery,
      model: settings.model,
      system: PROPOSER_AGENT_PROMPT,
      prompt: buildProposalText(request),
    },
    downgraded,
  };
}
