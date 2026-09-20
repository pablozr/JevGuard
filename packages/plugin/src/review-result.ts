import {
  aggregateReview,
  type ReviewLevelResult,
  type TurnReview,
  type UnavailableReason,
} from "@jevguard/core";

/**
 * Builds the observe-only result for a review lane that fails before it can reach
 * any rule or check identity. It carries the `REVIEW` kind so the presentation can
 * distinguish it from a rule result whose heading ID was also unavailable.
 */
export function reviewLevelUnavailable(
  turnId: string,
  reason: UnavailableReason,
): ReviewLevelResult {
  return {
    kind: "REVIEW",
    turnId,
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

/**
 * Wraps one synthetic review-level result in the same aggregate review shape core
 * evaluation returns, so every failure path presents exactly one aggregate.
 */
export function unavailableReview(turnId: string, reason: UnavailableReason): TurnReview {
  return aggregateReview(turnId, [reviewLevelUnavailable(turnId, reason)]);
}
