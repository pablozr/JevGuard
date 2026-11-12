import type { ReviewResult, Turn } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults";
import { selectTurnEvidence } from "../evidence/select-evidence";
import type { EvidencePolicy } from "../evidence/types";
import type { RuleParseResults } from "../rules/types";
import { collectFailFindings } from "./fail-findings";
import {
  REMEDIATION_MAX_TASK_LENGTH,
  type RemediationConfig,
  type RemediationProposalRequest,
} from "./types";

/** True when the configuration lets a `FAIL` trigger a proposal or a delivery. */
export function proposesOnFail(config: RemediationConfig): boolean {
  return config.autoPropose && config.proposeOn.includes("FAIL");
}

/**
 * Builds the single aggregate proposal request for an evaluated turn, or `null`
 * when auto-propose is disabled, the task is too long, no `FAIL` finding exists, or
 * the turn's complete, safe, full attributed patch is not selectable. Evidence is
 * always the whole attributed patch, never a rule-scoped subset, so a rule-scoped
 * `FAIL` alone never authorizes a proposal when the full turn evidence is unsafe.
 * A `null` request never hides the findings: a delivery is built from
 * `collectDeliveryFindings` and carries them without a proposal.
 */
export function buildProposalRequest(input: {
  readonly turn: Turn;
  readonly sessionID: string;
  readonly rules: RuleParseResults;
  readonly results: readonly ReviewResult[];
  readonly config: RemediationConfig;
  readonly evidencePolicy?: EvidencePolicy;
}): RemediationProposalRequest | null {
  if (!proposesOnFail(input.config)) {
    return null;
  }

  if (input.turn.task.length > REMEDIATION_MAX_TASK_LENGTH) {
    return null;
  }

  const selection = selectTurnEvidence(input.turn, input.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY);

  if (selection.status !== "SELECTED") {
    return null;
  }

  const { ruleFindings, builtInFindings } = collectFailFindings({
    files: input.turn.files,
    rules: input.rules,
    results: input.results,
  });

  if (ruleFindings.length === 0 && builtInFindings.length === 0) {
    return null;
  }

  return {
    evaluationId: input.turn.id,
    sessionID: input.sessionID,
    messageID: input.turn.id,
    model: input.config.model,
    task: input.turn.task,
    paths: [...selection.evidence.files],
    diff: selection.evidence.diff,
    ruleFindings,
    builtInFindings,
  };
}
