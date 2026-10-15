import { evaluateBuiltIns } from "../builtins/evaluate-builtins";
import type { Turn } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults";
import type { GateConfigResult } from "../gate/types";
import type { PolicyLoadResult } from "../ports/types";
import { aggregateReview } from "./aggregate";
import { loadPolicy, readPolicyConfig } from "./policy";
import { evaluateRuleCandidates, resolveRuleCandidates } from "./rule-lane";
import type { ReviewTurnDependencies, RuleLaneReview, TurnReviewOutcome } from "./types";

/**
 * Reviews one attributed turn: read the fixed policy paths once, then run the local
 * rule lane and the single built-in batch concurrently and aggregate them. A rejected
 * loader or rule/config failure degrades only the rule lane to a review-level
 * `UNAVAILABLE` and never suppresses the built-in batch. The final results are rules
 * in source order, then scope creep, then complexity, regardless of completion timing.
 * Presentation and remediation stay with the host.
 */
export async function reviewTurn(
  turn: Turn,
  dependencies: ReviewTurnDependencies,
): Promise<TurnReviewOutcome> {
  const loaded = await loadPolicy(dependencies.policy);
  const config = readPolicyConfig(loaded, dependencies.parseConfig);
  const builtInInput = { turn, evidencePolicy: DEFAULT_EVIDENCE_POLICY };

  const [ruleLane, builtIns] = await Promise.all([
    evaluateRuleLane(turn, loaded, config.gate, dependencies),
    evaluateBuiltIns(builtInInput, { jev: dependencies.jev }),
  ]);

  const review = aggregateReview(turn.id, [
    ...ruleLane.results,
    builtIns.scopeCreep,
    builtIns.complexity,
  ]);

  return { review, rules: ruleLane.rules, remediation: config.remediation };
}

async function evaluateRuleLane(
  turn: Turn,
  loaded: PolicyLoadResult | null,
  gate: GateConfigResult,
  dependencies: Pick<ReviewTurnDependencies, "jev">,
): Promise<RuleLaneReview> {
  const resolution = resolveRuleCandidates(turn.id, loaded);

  if (resolution.status === "UNAVAILABLE") {
    return resolution.lane;
  }

  return evaluateRuleCandidates(turn, resolution.rules, gate, dependencies);
}
