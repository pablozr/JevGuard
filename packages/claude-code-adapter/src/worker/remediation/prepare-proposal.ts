import type { ClaudeReviewHandoff } from "../../capture/types";
import type { ProposalDelivery } from "../../presentation";
import { parseProposalRequestFile } from "../../presentation";
import type { ReviewedHandoff, WorkerDependencies } from "../types";
import type { ChainDelivery } from "./request-file";
import { encodeProposalRequestFile } from "./request-file";
import type { ClaudeRemediationSettingsResult } from "./types";

function writeRequest(
  handoff: ClaudeReviewHandoff,
  proposal: NonNullable<ReviewedHandoff["proposal"]>,
  settings: Extract<ClaudeRemediationSettingsResult, { status: "ENABLED" }>,
  dependencies: WorkerDependencies,
  chain: ChainDelivery | undefined,
): ProposalDelivery | null {
  try {
    const now = dependencies.now();
    const { file, downgraded } = encodeProposalRequestFile({
      request: proposal,
      settings: settings.settings,
      turnId: handoff.turnId,
      now,
      ...(chain === undefined ? {} : { chain }),
    });

    // What the mod would reject must never be written: it would only strand the chain.
    if (
      parseProposalRequestFile(JSON.stringify(file), { turnId: handoff.turnId }, now.getTime()) ===
      null
    ) {
      return null;
    }

    if (downgraded) dependencies.log("PROPOSAL_DELIVERY_DOWNGRADED");

    return dependencies.proposals.write(handoff, file) === "WRITTEN" ? file.delivery : null;
  } catch {
    return null;
  }
}

/**
 * Writes the private proposal request for a reviewed unit when the user enabled
 * remediation and the review produced a complete, safe request; a `chain` makes it a
 * `remediate` delivery. Returns whether a request was written; it logs typed codes only and
 * never the task, the patch or a path.
 */
export function prepareProposal(
  handoff: ClaudeReviewHandoff,
  reviewed: ReviewedHandoff,
  settings: ClaudeRemediationSettingsResult,
  dependencies: WorkerDependencies,
  chain?: ChainDelivery,
): boolean {
  if (settings.status !== "ENABLED" || reviewed.proposal === null) return false;

  if (reviewed.projectModelIgnored) dependencies.log("REMEDIATION_PROJECT_MODEL_IGNORED");

  const delivery = writeRequest(handoff, reviewed.proposal, settings, dependencies, chain);

  if (delivery === null) {
    dependencies.log("PROPOSAL_REQUEST_WRITE_FAILED");

    return false;
  }

  dependencies.log(
    delivery === "agent" ? "PROPOSAL_REQUEST_WRITTEN:AGENT" : "PROPOSAL_REQUEST_WRITTEN:USER",
  );

  return true;
}
