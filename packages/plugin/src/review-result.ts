import type { ParsedRule, ReviewResult, UnavailableReason } from "@jevguard/core";

/**
 * Builds the observe-only operational result for a turn that never reached a
 * semantic judgment. `rule` is present only when a rule was parsed before the
 * failure; its paths are always empty because no evidence was selected.
 */
export function unavailableResult(
  turnId: string,
  rule: ParsedRule | null,
  reason: UnavailableReason,
): ReviewResult {
  return {
    turnId,
    ruleId: rule?.id ?? null,
    severity: rule?.severity ?? null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}
