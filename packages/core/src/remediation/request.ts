import type { ParsedRule, ReviewResult, Turn } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults";
import { selectTurnEvidence } from "../evidence/select-evidence";
import type { EvidencePolicy } from "../evidence/types";
import type { RuleParseResults } from "../rules/types";
import {
  REMEDIATION_MAX_TASK_LENGTH,
  type RemediationBuiltInFinding,
  type RemediationConfig,
  type RemediationProposalRequest,
  type RemediationRuleFinding,
  type RemediationRuleSnapshot,
} from "./types";

/**
 * Builds the single aggregate proposal request for an evaluated turn, or `null`
 * when auto-propose is disabled, the task is too long, no `FAIL` finding exists, or
 * the turn's complete, safe, full attributed patch is not selectable. Evidence is
 * always the whole attributed patch, never a rule-scoped subset, so a rule-scoped
 * `FAIL` alone never authorizes a proposal when the full turn evidence is unsafe.
 */
export function buildProposalRequest(input: {
  readonly turn: Turn;
  readonly sessionID: string;
  readonly rules: RuleParseResults;
  readonly results: readonly ReviewResult[];
  readonly config: RemediationConfig;
  readonly evidencePolicy?: EvidencePolicy;
}): RemediationProposalRequest | null {
  if (!input.config.autoPropose || !input.config.proposeOn.includes("FAIL")) {
    return null;
  }

  if (input.turn.task.length > REMEDIATION_MAX_TASK_LENGTH) {
    return null;
  }

  const selection = selectTurnEvidence(input.turn, input.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY);

  if (selection.status !== "SELECTED") {
    return null;
  }

  const ruleFindings = collectRuleFindings(input.results, indexParsedRules(input.rules));
  const builtInFindings = collectBuiltInFindings(input.results);

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

function collectRuleFindings(
  results: readonly ReviewResult[],
  rulesById: ReadonlyMap<string, ParsedRule>,
): readonly RemediationRuleFinding[] {
  const findings: RemediationRuleFinding[] = [];

  for (const result of results) {
    if (!isFailingRule(result)) {
      continue;
    }

    const rule = rulesById.get(result.ruleId);

    if (rule === undefined) {
      continue;
    }

    findings.push({
      ruleId: rule.id,
      severity: "error",
      rule: snapshotRule(rule),
      probability: result.violationProbability,
      scopedPaths: [...result.scopedPaths],
    });
  }

  return findings;
}

function collectBuiltInFindings(
  results: readonly ReviewResult[],
): readonly RemediationBuiltInFinding[] {
  const findings: RemediationBuiltInFinding[] = [];

  for (const result of results) {
    if (result.kind !== "BUILT_IN" || result.outcome !== "FAIL") {
      continue;
    }

    findings.push({
      checkId: result.checkId,
      severity: result.severity,
      probability: result.violationProbability,
      scopedPaths: [...result.scopedPaths],
    });
  }

  return findings;
}

function isFailingRule(result: ReviewResult): result is Extract<ReviewResult, { kind: "RULE" }> & {
  readonly outcome: "FAIL";
  readonly severity: "error";
  readonly ruleId: string;
} {
  return (
    result.kind === "RULE" &&
    result.outcome === "FAIL" &&
    result.severity === "error" &&
    result.ruleId !== null
  );
}

function indexParsedRules(rules: RuleParseResults): ReadonlyMap<string, ParsedRule> {
  const byId = new Map<string, ParsedRule>();

  for (const candidate of rules) {
    if (candidate.status === "PARSED") {
      byId.set(candidate.rule.id, candidate.rule);
    }
  }

  return byId;
}

function snapshotRule(rule: ParsedRule): RemediationRuleSnapshot {
  return {
    id: rule.id,
    description: rule.description,
    violation: rule.violation,
    allowed: rule.allowed ?? "",
  };
}
