import type { ReportRecord } from "../report/types";
import type { FailIdentity, FeedbackDecision, FeedbackRecord, RuleFail } from "./types";

export function failIdentityKey(identity: FailIdentity): string {
  return JSON.stringify([identity.turnId, identity.ruleId]);
}

/**
 * Distinct repository-rule FAILs in the history. Built-ins, non-FAIL outcomes, and
 * results without a rule ID are excluded; a duplicate identity keeps its newest record.
 */
export function collectRuleFails(records: readonly ReportRecord[]): ReadonlyMap<string, RuleFail> {
  const fails = new Map<string, RuleFail>();

  for (const record of records) {
    for (const result of record.results) {
      if (result.kind !== "RULE" || result.ruleId === null || result.outcome !== "FAIL") {
        continue;
      }

      const fail: RuleFail = {
        turnId: record.turnId,
        ruleId: result.ruleId,
        timestamp: record.timestamp,
        violationProbability: result.violationProbability,
      };
      const key = failIdentityKey(fail);
      const existing = fails.get(key);

      if (existing === undefined || fail.timestamp >= existing.timestamp) {
        fails.set(key, fail);
      }
    }
  }

  return fails;
}

/** Latest decision per FAIL identity: the last record wins, as file order is write order. */
export function latestDecisions(
  feedback: readonly FeedbackRecord[],
): ReadonlyMap<string, FeedbackDecision> {
  const decisions = new Map<string, FeedbackDecision>();

  for (const record of feedback) {
    decisions.set(failIdentityKey(record), record.decision);
  }

  return decisions;
}
