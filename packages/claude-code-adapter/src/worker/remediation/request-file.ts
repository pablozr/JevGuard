import type { DeliveryFindings, RemediationProposalRequest } from "@jevguard/core";
import { buildProposalText, PROPOSER_AGENT_PROMPT } from "@jevguard/core";
import { ORPHAN_TTL_MS } from "../../capture/unit-state";
import type { ProposalRequestFile } from "../../presentation";
import type { ClaudeRemediationSettings } from "./types";

/**
 * Encodes a unit's private request. With a core proposal request the proposer prompts are
 * exactly what the proposer receives (the model is the user's, never the project's); with
 * `null` they are `null` and the request carries only the findings for an `agent` delivery.
 * `delivery` is the user's choice; `fromDelivery` tells the mod the unit is itself an
 * automatic delivery, so it never triggers another one. Only an `agent` request carries
 * the findings, and they are never downgraded for their size: the core already bounded them.
 */
export function encodeProposalRequestFile(input: {
  readonly request: RemediationProposalRequest | null;
  readonly findings: DeliveryFindings;
  readonly fromDelivery: boolean;
  readonly settings: ClaudeRemediationSettings;
  readonly turnId: string;
  readonly now: Date;
}): ProposalRequestFile {
  const { request, findings, fromDelivery, settings, turnId, now } = input;
  const { delivery, model } = settings;
  const carriesFindings = delivery === "agent";

  return {
    v: 2,
    kind: "PROPOSAL_REQUEST",
    turnId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ORPHAN_TTL_MS).toISOString(),
    delivery,
    fromDelivery,
    model,
    system: request === null ? null : PROPOSER_AGENT_PROMPT,
    prompt: request === null ? null : buildProposalText(request),
    findings: carriesFindings ? findings.findings : [],
    omitted: carriesFindings ? findings.omitted : 0,
  };
}
