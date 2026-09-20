import {
  aggregateReview,
  type ParsedRule,
  type RuleReviewResult,
  type TurnReview,
  type UnavailableReason,
} from "@jevguard/core";

/**
 * Builds the observe-only result for one rule that never reached a semantic
 * judgment. `rule` is present only when a rule was parsed before the failure; its
 * paths are always empty because no evidence was selected.
 */
function unavailableResult(
  turnId: string,
  rule: ParsedRule | null,
  reason: UnavailableReason,
): RuleReviewResult {
  return {
    turnId,
    ruleId: rule?.id ?? null,
    severity: rule?.severity ?? null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

/**
 * Wraps one synthetic unavailable result in the same aggregate review shape core
 * evaluation returns, so every failure path presents exactly one aggregate.
 */
export function unavailableReview(
  turnId: string,
  rule: ParsedRule | null,
  reason: UnavailableReason,
): TurnReview {
  return aggregateReview(turnId, [unavailableResult(turnId, rule, reason)]);
}
