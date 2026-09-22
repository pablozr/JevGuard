import { parseRules } from "@jevguard/core";
import type { RuleDocumentSummary } from "../types";

/**
 * Parses a rule document with the production parser and reduces the result to a
 * safe summary. No rule description, violation, allowed text, or raw document
 * content is retained.
 */
export function summarizeRules(text: string): RuleDocumentSummary {
  const results = parseRules(text);
  const ruleIds: string[] = [];
  const invalidRuleIds: (string | null)[] = [];
  const errorCodes: string[] = [];

  for (const result of results) {
    if (result.status === "PARSED") {
      ruleIds.push(result.rule.id);
      continue;
    }

    invalidRuleIds.push(result.ruleId);
    errorCodes.push(result.code);
  }

  return {
    status: invalidRuleIds.length === 0 ? "valid" : "invalid",
    ruleCount: results.length,
    ruleIds,
    invalidCount: invalidRuleIds.length,
    invalidRuleIds,
    errorCodes: [...new Set(errorCodes)],
  };
}
