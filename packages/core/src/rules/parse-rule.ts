import type { RuleCandidateResult, RuleParseResult } from "./types";
import { collectRuleBlocks, parseRuleBlock, ruleParseFailure } from "./blocks";

/**
 * Parses one `.jev/rules.md` document into a validated rule, or reports a
 * deterministic `INVALID_RULE` structure. Text only; no file access, scope
 * evaluation, or Jev call.
 *
 * V0.1 compatibility: exactly one rule heading is accepted, a document with more
 * than one heading is `MULTIPLE_RULES`, and failures never carry a `ruleId`.
 */
export function parseRule(text: string): RuleParseResult {
  const blocks = collectRuleBlocks(text);
  const first = blocks[0];

  if (first === undefined) {
    return ruleParseFailure("MISSING_ID");
  }

  if (blocks.length > 1) {
    return ruleParseFailure("MULTIPLE_RULES");
  }

  return toRuleParseResult(parseRuleBlock(first, false));
}

function toRuleParseResult(result: RuleCandidateResult): RuleParseResult {
  if (result.status === "PARSED") {
    return result;
  }

  return { status: "INVALID", reason: result.reason, code: result.code };
}
