import type { ReviewResult } from "@jevguard/core";
import type { EnforceDecision, EnforceInput, EnforceStopOutput } from "./types";

/** The host caps the reason; ADR 0022 keeps it well under that (decision 5). */
export const ENFORCE_REASON_MAX_LENGTH = 2000;

const REASON_PREFIX = "JevGuard blocked this turn: ";
const REASON_SUFFIX =
  " failed. Fix the change, or explain why the rule does not apply, then finish the turn again.";

function reasonLine(ruleIds: readonly string[]): string {
  return `${REASON_PREFIX}${ruleIds.join(", ")}${REASON_SUFFIX}`;
}

/**
 * The block reason, built only from allowlisted rule IDs and one fixed instruction. It
 * names as many rules as fit under the length cap and counts the rest, so a rule ID is
 * never cut in half. It never carries rule text, a diff, the task, a path, a finding or
 * a credential.
 */
export function enforceReason(ruleIds: readonly string[]): string {
  const named: string[] = [];

  for (const ruleId of ruleIds) {
    if (reasonLine([...named, ruleId]).length > ENFORCE_REASON_MAX_LENGTH) break;

    named.push(ruleId);
  }

  if (named.length === ruleIds.length) return reasonLine(named);

  const withCount = (count: number): string =>
    `${REASON_PREFIX}${named.slice(0, count).join(", ")} and ${ruleIds.length - count} more${REASON_SUFFIX}`;
  let count = named.length;

  while (count > 0 && withCount(count).length > ENFORCE_REASON_MAX_LENGTH) count -= 1;

  return count > 0 ? withCount(count) : `${REASON_PREFIX}${ruleIds.length} rules${REASON_SUFFIX}`;
}

/**
 * The blocking allowlisted rules, in configured order. Only a local rule with severity
 * `error` that reached `FAIL` counts: a built-in, a warning rule and any operational
 * result are skipped whatever the allowlist says.
 */
function blockingRuleIds(
  results: readonly ReviewResult[],
  allowlist: readonly string[],
): readonly string[] {
  const failing = new Set<string>();

  for (const result of results) {
    if (result.kind !== "RULE") continue;
    if (result.outcome !== "FAIL" || result.severity !== "error") continue;
    if (result.ruleId === null || !allowlist.includes(result.ruleId)) continue;

    failing.add(result.ruleId);
  }

  return allowlist.filter((ruleId) => failing.has(ruleId));
}

/**
 * Decides whether the closing turn is held, from data only. Every guard that cannot be
 * answered positively fails open: a session not positively interactive, an unknown or
 * active background task, a second stop of the same unit, an acknowledged unit, and a
 * review with no allowlisted `error` rule in `FAIL`. A built-in never blocks and neither
 * does an operational result, whatever the allowlist says.
 */
export function decideEnforce(input: EnforceInput): EnforceDecision {
  const allowlist = input.settings.rules;

  if (allowlist.length === 0) return { block: false, code: "ENFORCE_NO_ELIGIBLE_RULES" };
  if (input.session !== "INTERACTIVE") return { block: false, code: "ENFORCE_NON_INTERACTIVE" };
  if (input.backgroundTasks !== "EMPTY") {
    return { block: false, code: "ENFORCE_BACKGROUND_TASK" };
  }
  if (input.stopHookActive || input.unitAlreadyBlocked) {
    return { block: false, code: "ENFORCE_CAP_REACHED" };
  }
  if (input.acknowledged) return { block: false, code: "ENFORCE_ACKED" };

  const ruleIds = blockingRuleIds(input.review.results, allowlist);

  if (ruleIds.length === 0) return { block: false, code: "ENFORCE_NO_FAIL" };

  return { block: true, ruleIds, reason: enforceReason(ruleIds) };
}

/** What the `Stop` hook prints: the documented JSON decision, or nothing at all. */
export function toStopOutput(decision: EnforceDecision): EnforceStopOutput | null {
  return decision.block ? { decision: "block", reason: decision.reason } : null;
}
