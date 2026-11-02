import type { DeliveryFinding } from "./delivery-frame";
import type { RemediationProposalRequest } from "./types";

/**
 * The findings a remediation delivery shows the agent, from the core's request: rule
 * findings with the rule's own violation and allowed text, then built-in checks.
 */
export function deliveryFindingsOf(request: RemediationProposalRequest): DeliveryFinding[] {
  return [
    ...request.ruleFindings.map((finding) => ({
      id: finding.ruleId,
      severity: finding.severity,
      probability: finding.probability,
      paths: finding.scopedPaths,
      violation: finding.rule.violation,
      allowed: finding.rule.allowed,
    })),
    ...request.builtInFindings.map((finding) => ({
      id: finding.checkId,
      severity: finding.severity,
      probability: finding.probability,
      paths: finding.scopedPaths,
      violation: null,
      allowed: null,
    })),
  ];
}
