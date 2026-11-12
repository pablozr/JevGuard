import { buildScopeCreepQuestion, SCOPE_CREEP_CHECK_ID } from "../builtins/scope-creep";
import type { ReviewResult, Turn } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults";
import { checkFilePath } from "../evidence/safety";
import type { EvidencePolicy } from "../evidence/types";
import type { RuleParseResults } from "../rules/types";
import { collectFailFindings, type FailFindings } from "./fail-findings";
import {
  DELIVERY_MAX_FINDING_PATH_LENGTH,
  DELIVERY_MAX_FINDING_TEXT_LENGTH,
  DELIVERY_MAX_FINDINGS,
  type DeliveryFinding,
  type DeliveryFindings,
  type FindingLocation,
  type RemediationBuiltInFinding,
  type RemediationRuleFinding,
} from "./types";

/**
 * The findings a remediation delivery shows the agent, from the core's `FAIL` findings:
 * rule findings with the rule's own text, then built-in checks with their fixed criteria.
 * Not bounded; `collectDeliveryFindings` is the bounded form a host delivers.
 */
export function deliveryFindingsOf(findings: FailFindings): DeliveryFinding[] {
  return [
    ...findings.ruleFindings.map(ruleDeliveryFinding),
    ...findings.builtInFindings.map(builtInDeliveryFinding),
  ];
}

/**
 * Every `FAIL` finding of a reviewed turn as a delivery carries it, independent of the
 * proposer request and of the diff size: locations come from the per-file patches and never
 * name a path the evidence policy blocks. At most `DELIVERY_MAX_FINDINGS` findings are kept,
 * their texts and paths are cut to the delivery limits, and the rest are counted in `omitted`.
 */
export function collectDeliveryFindings(input: {
  readonly turn: Turn;
  readonly rules: RuleParseResults;
  readonly results: readonly ReviewResult[];
  readonly evidencePolicy?: EvidencePolicy;
}): DeliveryFindings {
  const policy = input.evidencePolicy ?? DEFAULT_EVIDENCE_POLICY;
  const all = deliveryFindingsOf(
    collectFailFindings({ files: input.turn.files, rules: input.rules, results: input.results }),
  );
  const kept = all.slice(0, DELIVERY_MAX_FINDINGS);

  return {
    findings: kept.map((finding) => boundedFinding(finding, policy)),
    omitted: all.length - kept.length,
  };
}

function boundedFinding(finding: DeliveryFinding, policy: EvidencePolicy): DeliveryFinding {
  return {
    ...finding,
    description: boundedText(finding.description),
    violation: boundedText(finding.violation),
    allowed: boundedText(finding.allowed),
    locations: finding.locations
      .filter((location) => checkFilePath(location.path, policy).allowed)
      .map(boundedLocation),
  };
}

function boundedLocation(location: FindingLocation): FindingLocation {
  return { ...location, path: location.path.slice(0, DELIVERY_MAX_FINDING_PATH_LENGTH) };
}

function boundedText(text: string): string {
  return text.slice(0, DELIVERY_MAX_FINDING_TEXT_LENGTH);
}

function ruleDeliveryFinding(finding: RemediationRuleFinding): DeliveryFinding {
  return {
    id: finding.ruleId,
    kind: "RULE",
    description: finding.rule.description,
    severity: finding.severity,
    probability: finding.probability,
    violation: finding.rule.violation,
    allowed: finding.rule.allowed,
    locations: finding.locations,
  };
}

function builtInDeliveryFinding(finding: RemediationBuiltInFinding): DeliveryFinding {
  const criteria =
    finding.checkId === SCOPE_CREEP_CHECK_ID ? buildScopeCreepQuestion().criteria : null;

  return {
    id: finding.checkId,
    kind: "BUILT_IN",
    description: criteria?.description ?? finding.checkId,
    severity: finding.severity,
    probability: finding.probability,
    violation: criteria?.violation ?? "",
    allowed: criteria?.allowed ?? "",
    locations: finding.locations,
  };
}
