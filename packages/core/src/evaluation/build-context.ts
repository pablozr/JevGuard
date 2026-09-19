import type { ParsedRule, ReviewContext, Turn } from "../domain/types";

export function buildReviewContext(
  turn: Turn,
  rule: ParsedRule,
  scopedPaths: readonly string[],
): ReviewContext {
  return {
    turnId: turn.id,
    ruleId: rule.id,
    severity: rule.severity,
    scopedPaths,
  };
}
