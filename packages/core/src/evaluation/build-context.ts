import type { ParsedRule, RuleReviewContext, Turn } from "../domain/types";

export function buildReviewContext(
  turn: Turn,
  rule: ParsedRule,
  scopedPaths: readonly string[],
): RuleReviewContext {
  return {
    kind: "RULE",
    turnId: turn.id,
    ruleId: rule.id,
    severity: rule.severity,
    scopedPaths,
  };
}
