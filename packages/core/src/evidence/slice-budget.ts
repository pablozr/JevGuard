import type { BudgetedRulePlan, RuleEvidencePlan } from "./types";

/** Maximum number of slices a single repository rule may produce. */
export const MAX_SLICES_PER_RULE = 16;

/** Maximum slice calls a turn may add beyond one per planned repository rule. */
export const MAX_EXTRA_RULE_CALLS_PER_TURN = 32;

/**
 * Reserves the turn's slice budget over per-rule plans in policy source order. A rule
 * whose slice count exceeds the per-rule cap or the remaining extra-call budget becomes
 * `SLICE_LIMIT_EXCEEDED`, consumes no budget, and later rules still use what remains.
 * A whole (one-slice) rule costs no extra call and is always admitted. No plan is
 * silently dropped.
 */
export function planTurnRuleSlices(
  plans: readonly RuleEvidencePlan[],
): readonly BudgetedRulePlan[] {
  let remainingExtraCalls = MAX_EXTRA_RULE_CALLS_PER_TURN;

  return plans.map((plan) => {
    if (plan.status !== "PLANNED") {
      return plan;
    }

    const extraCalls = plan.slices.length - 1;

    if (plan.slices.length > MAX_SLICES_PER_RULE || extraCalls > remainingExtraCalls) {
      return { status: "SLICE_LIMIT_EXCEEDED", slices: plan.slices };
    }

    remainingExtraCalls -= extraCalls;

    return plan;
  });
}
