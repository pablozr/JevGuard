import type { RuleCandidateResult, RuleParseResults } from "../rules/types";
import { aggregateReview } from "./aggregate";
import { loadPolicy, readPolicyConfig } from "./policy";
import { evaluateRuleCandidates, resolveRuleCandidates } from "./rule-lane";
import type { CheckRulesInput, ReviewTurnDependencies, RuleCheckOutcome } from "./types";

/**
 * Runs only the repository-rule lane over one provided turn, on demand. Built-in
 * checks never run and remediation never applies. A `ruleId` filter is applied to
 * the parsed rule candidates before Jev and before the per-turn slice budget, so only
 * the selected rule counts against it. An unknown `ruleId` is `RULE_NOT_FOUND` without
 * calling Jev; a policy that cannot be loaded degrades to a review-level `UNAVAILABLE`.
 */
export async function checkRules(
  input: CheckRulesInput,
  dependencies: ReviewTurnDependencies,
): Promise<RuleCheckOutcome> {
  const { turn, ruleId } = input;
  const loaded = await loadPolicy(dependencies.policy);
  const resolution = resolveRuleCandidates(turn.id, loaded);

  if (resolution.status === "UNAVAILABLE") {
    return { status: "REVIEWED", review: aggregateReview(turn.id, resolution.lane.results) };
  }

  const candidates = selectCandidates(resolution.rules, ruleId);

  if (candidates.length === 0) {
    return { status: "RULE_NOT_FOUND" };
  }

  const config = readPolicyConfig(loaded, dependencies.parseConfig);
  const lane = await evaluateRuleCandidates(turn, candidates, config.gate, dependencies);

  return { status: "REVIEWED", review: aggregateReview(turn.id, lane.results) };
}

function selectCandidates(rules: RuleParseResults, ruleId: string | null): RuleParseResults {
  if (ruleId === null) {
    return rules;
  }

  return rules.filter((candidate) => candidateId(candidate) === ruleId);
}

function candidateId(candidate: RuleCandidateResult): string | null {
  return candidate.status === "PARSED" ? candidate.rule.id : candidate.ruleId;
}
