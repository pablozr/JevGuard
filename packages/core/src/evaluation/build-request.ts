import type { ParsedRule, RuleEvidence } from "../domain/types";
import type { JevRuleRequest } from "../ports/types";

const NOUL_INSTRUCTIONS =
  "Answer true when the attributed change violates the rule's Violation, excluding behavior described by the rule's Allowed exception. Answer false when the change does not violate the rule, including allowed behavior. Return the probability from 0 to 1 that the change violates the rule.";

/**
 * Builds the single Noul request for one rule and its complete scoped evidence.
 * An absent `allowed` exception is omitted rather than sent as a null criterion.
 */
export function buildJevRequest(
  task: string,
  rule: ParsedRule,
  evidence: RuleEvidence,
): JevRuleRequest {
  return {
    task,
    question: {
      type: "noul",
      instructions: NOUL_INSTRUCTIONS,
      criteria: {
        id: rule.id,
        description: rule.description,
        violation: rule.violation,
        ...(rule.allowed === null ? {} : { allowed: rule.allowed }),
      },
    },
    change: { files: evidence.files, diff: evidence.diff },
  };
}
