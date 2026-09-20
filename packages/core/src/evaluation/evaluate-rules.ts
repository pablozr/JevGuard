import type { ParsedRule, RuleReviewResult, Turn } from "../domain/types";
import { aggregateReview } from "../review/aggregate";
import type { TurnReview } from "../review/types";
import type { RuleCandidateFailure, RuleCandidateResult } from "../rules/types";
import { buildReviewContext } from "./build-context";
import { evaluateRule } from "./evaluate-rule";
import type { EvaluateRuleDependencies, EvaluateRuleInput, EvaluateRulesInput } from "./types";

/**
 * Evaluates every parsed rule block for one turn in source order. A parse failure
 * or an invalid gate configuration becomes a per-rule `UNAVAILABLE` result without
 * calling Jev; each valid block is evaluated through the existing single-rule
 * orchestration, and one rule's failure never stops the remaining rules.
 */
export async function evaluateRules(
  input: EvaluateRulesInput,
  dependencies: EvaluateRuleDependencies,
): Promise<TurnReview> {
  const results: RuleReviewResult[] = [];

  for (const rule of input.rules) {
    results.push(await evaluateRuleResult(input, rule, dependencies));
  }

  return aggregateReview(input.turn.id, results);
}

async function evaluateRuleResult(
  input: EvaluateRulesInput,
  rule: RuleCandidateResult,
  dependencies: EvaluateRuleDependencies,
): Promise<RuleReviewResult> {
  if (rule.status === "INVALID") {
    return invalidRuleResult(input.turn.id, rule);
  }

  if (input.gateConfig.status === "INVALID") {
    return invalidConfigResult(input.turn, rule.rule);
  }

  const ruleInput: EvaluateRuleInput = {
    turn: input.turn,
    rule: rule.rule,
    gateConfig: input.gateConfig.config,
    evidencePolicy: input.evidencePolicy,
  };

  return evaluateRule(ruleInput, dependencies);
}

function invalidRuleResult(turnId: string, failure: RuleCandidateFailure): RuleReviewResult {
  return {
    kind: "RULE",
    turnId,
    ruleId: failure.ruleId,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason: "INVALID_RULE",
  };
}

function invalidConfigResult(turn: Turn, rule: ParsedRule): RuleReviewResult {
  return {
    ...buildReviewContext(turn, rule, []),
    outcome: "UNAVAILABLE",
    reason: "INVALID_CONFIG",
  };
}
