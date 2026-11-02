import type { RemediationProposalRequest } from "@jevguard/core";
import { buildProposalText, deliveryFindingsOf, PROPOSER_AGENT_PROMPT } from "@jevguard/core";
import { ORPHAN_TTL_MS } from "../../capture/unit-state";
import type { DeliveryChain } from "../../presentation";
import {
  DELIVERY_MAX_FINDING_TEXT_LENGTH,
  fitsDeliveryLimits,
  isAutoDeliveredTask,
} from "../../presentation";
import type { ClaudeRemediationSettings, EncodedProposalRequest } from "./types";

/** Where a `remediate` delivery stands; the findings come from the request itself. */
export interface ChainDelivery {
  readonly chainId: string;
  readonly attempt: number;
  readonly maxAttempts: number;
}

function clipped(text: string | null): string | null {
  return text === null ? null : text.slice(0, DELIVERY_MAX_FINDING_TEXT_LENGTH);
}

function findingsOf(request: RemediationProposalRequest): DeliveryChain["findings"] {
  return deliveryFindingsOf(request).map((finding) => ({
    ...finding,
    violation: clipped(finding.violation),
    allowed: clipped(finding.allowed),
  }));
}

/**
 * Whether the request's findings fit what the mod accepts (count, paths and path length).
 * The set the decision rests on is never truncated, so one that does not fit is not sent.
 */
export function fitsChainRequest(request: RemediationProposalRequest): boolean {
  return fitsDeliveryLimits(findingsOf(request));
}

function chainOf(request: RemediationProposalRequest, delivery: ChainDelivery): DeliveryChain {
  return { ...delivery, findings: findingsOf(request) };
}

/**
 * Encodes the core's proposal request exactly as the proposer receives it: the same
 * system prompt and user text. The model is the user's, never the project's, and an
 * `agent` delivery is downgraded to `user` when the unit's task is itself an automatic
 * delivery, so a plain proposal can never trigger another one. A `chain` is the exception:
 * the core's chain decision already bounded it, so it is always an `agent` delivery that
 * carries the chain and its findings.
 */
export function encodeProposalRequestFile(input: {
  readonly request: RemediationProposalRequest;
  readonly settings: ClaudeRemediationSettings;
  readonly turnId: string;
  readonly now: Date;
  readonly chain?: ChainDelivery;
}): EncodedProposalRequest {
  const { request, settings, turnId, now, chain } = input;
  const downgraded =
    chain === undefined && settings.delivery === "agent" && isAutoDeliveredTask(request.task);

  return {
    file: {
      v: 1,
      kind: "PROPOSAL_REQUEST",
      turnId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ORPHAN_TTL_MS).toISOString(),
      delivery: chain !== undefined ? "agent" : downgraded ? "user" : settings.delivery,
      model: settings.model,
      system: PROPOSER_AGENT_PROMPT,
      prompt: buildProposalText(request),
      ...(chain === undefined ? {} : { chain: chainOf(request, chain) }),
    },
    downgraded,
  };
}
