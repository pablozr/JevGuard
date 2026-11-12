import type { ClaudeReviewHandoff } from "../../capture/types";
import type { ProposalDelivery } from "../../presentation";
import { parseProposalRequestFile } from "../../presentation";
import type { ReviewedHandoff, WorkerDependencies } from "../types";
import { encodeProposalRequestFile } from "./request-file";
import type { ClaudeRemediationSettings, ClaudeRemediationSettingsResult } from "./types";

/**
 * A unit is delivered to the agent whenever it has `FAIL` findings and the user chose `agent`,
 * with or without a proposer request; a panel proposal needs the request, and a unit that is
 * itself an automatic delivery never gets a findings-only request, since the mod would only
 * show it in a panel.
 */
function needsRequest(reviewed: ReviewedHandoff, settings: ClaudeRemediationSettings): boolean {
  if (reviewed.proposal !== null) return true;

  return (
    settings.delivery === "agent" && !reviewed.fromDelivery && reviewed.findings.findings.length > 0
  );
}

function writeRequest(
  handoff: ClaudeReviewHandoff,
  reviewed: ReviewedHandoff,
  settings: ClaudeRemediationSettings,
  dependencies: WorkerDependencies,
): ProposalDelivery | null {
  try {
    const now = dependencies.now();
    const file = encodeProposalRequestFile({
      request: reviewed.proposal,
      findings: reviewed.findings,
      fromDelivery: reviewed.fromDelivery,
      settings,
      turnId: handoff.turnId,
      now,
    });

    // What the mod would reject must never be written: it would only strand the request.
    if (
      parseProposalRequestFile(JSON.stringify(file), { turnId: handoff.turnId }, now.getTime()) ===
      null
    ) {
      return null;
    }

    return dependencies.proposals.write(handoff, file) === "WRITTEN" ? file.delivery : null;
  } catch {
    return null;
  }
}

/**
 * Writes the private request for a reviewed unit when the user enabled remediation and the
 * unit has something to deliver. Returns whether a request was written; it logs typed codes
 * only and never the task, the patch or a path.
 */
export function prepareProposal(
  handoff: ClaudeReviewHandoff,
  reviewed: ReviewedHandoff,
  settings: ClaudeRemediationSettingsResult,
  dependencies: WorkerDependencies,
): boolean {
  if (settings.status !== "ENABLED" || !needsRequest(reviewed, settings.settings)) return false;

  if (reviewed.projectModelIgnored) dependencies.log("REMEDIATION_PROJECT_MODEL_IGNORED");

  const delivery = writeRequest(handoff, reviewed, settings.settings, dependencies);

  if (delivery === null) {
    dependencies.log("PROPOSAL_REQUEST_WRITE_FAILED");

    return false;
  }

  dependencies.log(
    delivery === "agent" ? "PROPOSAL_REQUEST_WRITTEN:AGENT" : "PROPOSAL_REQUEST_WRITTEN:USER",
  );

  return true;
}
