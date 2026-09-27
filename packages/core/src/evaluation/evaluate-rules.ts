import type { GateConfig, ParsedRule, RuleReviewResult, Turn } from "../domain/types";
import { planRuleEvidence } from "../evidence/plan-slices";
import { planTurnRuleSlices } from "../evidence/slice-budget";
import type { BudgetedRulePlan, EvidenceSlice } from "../evidence/types";
import type { JevRuleEvaluationResult, JevRuleRequest } from "../ports/types";
import { aggregateReview } from "../review/aggregate";
import type { TurnReview } from "../review/types";
import type { RuleCandidateFailure } from "../rules/types";
import { assembleSlicedRuleResult, overBudgetMetadata } from "./assemble-rule";
import { buildJevRequest } from "./build-request";
import { buildReviewContext } from "./build-context";
import { evaluateRuleBatchWithPort } from "./evaluate-with-port";
import type { EvaluateRuleDependencies, EvaluateRulesInput } from "./types";

interface RulePlanSlot {
  readonly kind: "PLAN";
  readonly rule: ParsedRule;
  readonly plan: BudgetedRulePlan;
}

type RuleSlot = { readonly kind: "RESULT"; readonly result: RuleReviewResult } | RulePlanSlot;

/**
 * Evaluates every parsed rule block for one turn in source order. Planning is pure
 * local work: invalid rules and an invalid gate configuration short-circuit without a
 * plan, every other rule plans its complete slices, and the turn's slice budget is
 * reserved over those plans before any judgement is dispatched. All planned slices
 * from every rule then go through one batched port call, and results are assembled by
 * rule and input index so ordering never depends on completion order. One rule's
 * failure never stops the remaining rules.
 */
export async function evaluateRules(
  input: EvaluateRulesInput,
  dependencies: EvaluateRuleDependencies,
): Promise<TurnReview> {
  if (input.gateConfig.status === "INVALID") {
    const results = input.rules.map((candidate) =>
      candidate.status === "INVALID"
        ? invalidRuleResult(input.turn.id, candidate)
        : invalidConfigResult(input.turn, candidate.rule),
    );

    return aggregateReview(input.turn.id, results);
  }

  const gateConfig = input.gateConfig.config;
  const slots = resolveSlots(input);
  const requests = collectRequests(input.turn.task, slots);
  const evaluations =
    requests.length === 0 ? [] : await evaluateRuleBatchWithPort(dependencies.jev, requests);

  return aggregateReview(input.turn.id, assembleResults(input, slots, evaluations, gateConfig));
}

/**
 * Plans every rule, then reserves the turn's slice budget over the planned rules in
 * source order. The budget is applied before dispatch so reservation never depends on
 * completion order.
 */
function resolveSlots(input: EvaluateRulesInput): readonly RuleSlot[] {
  const planned = input.rules.map((candidate) =>
    candidate.status === "INVALID"
      ? { kind: "RESULT" as const, result: invalidRuleResult(input.turn.id, candidate) }
      : {
          kind: "PLAN" as const,
          rule: candidate.rule,
          plan: planRuleEvidence(input.turn, candidate.rule, input.evidencePolicy),
        },
  );

  const budgeted = planTurnRuleSlices(
    planned.flatMap((slot) => (slot.kind === "PLAN" ? [slot.plan] : [])),
  );

  let cursor = 0;

  return planned.map((slot) => {
    if (slot.kind === "RESULT") {
      return slot;
    }

    const plan = budgeted[cursor];
    cursor += 1;

    return plan === undefined ? slot : { kind: "PLAN", rule: slot.rule, plan };
  });
}

/**
 * Flattens every admitted rule's slices into one request array in source order. Each
 * request repeats the same task and the same rule criteria with `Allowed` inside the
 * one Noul.
 */
function collectRequests(task: string, slots: readonly RuleSlot[]): readonly JevRuleRequest[] {
  const requests: JevRuleRequest[] = [];

  for (const slot of slots) {
    if (slot.kind !== "PLAN" || slot.plan.status !== "PLANNED") {
      continue;
    }

    for (const slice of slot.plan.slices) {
      requests.push(buildJevRequest(task, slot.rule, { files: slice.files, diff: slice.diff }));
    }
  }

  return requests;
}

function assembleResults(
  input: EvaluateRulesInput,
  slots: readonly RuleSlot[],
  evaluations: readonly JevRuleEvaluationResult[],
  gateConfig: GateConfig,
): readonly RuleReviewResult[] {
  const results: RuleReviewResult[] = [];
  let evaluationCursor = 0;

  for (const slot of slots) {
    if (slot.kind === "RESULT") {
      results.push(slot.result);
      continue;
    }

    const plan = slot.plan;

    if (plan.status === "SKIPPED") {
      results.push(skippedResult(input.turn, slot.rule, plan.reason));
      continue;
    }

    if (plan.status === "UNAVAILABLE") {
      results.push(unavailableResult(input.turn, slot.rule, plan.reason));
      continue;
    }

    if (plan.status === "SLICE_LIMIT_EXCEEDED") {
      results.push({
        ...buildReviewContext(input.turn, slot.rule, collectSlicePaths(plan.slices)),
        outcome: "UNAVAILABLE",
        reason: "SLICE_LIMIT_EXCEEDED",
        evidence: overBudgetMetadata(plan.slices),
      });
      continue;
    }

    const sliceEvaluations = evaluations.slice(
      evaluationCursor,
      evaluationCursor + plan.slices.length,
    );
    evaluationCursor += plan.slices.length;

    results.push(
      assembleSlicedRuleResult(
        slot.rule,
        buildReviewContext(input.turn, slot.rule, collectSlicePaths(plan.slices)),
        plan.slices,
        sliceEvaluations,
        gateConfig,
      ),
    );
  }

  return results;
}

function collectSlicePaths(slices: readonly EvidenceSlice[]): readonly string[] {
  const paths: string[] = [];

  for (const slice of slices) {
    for (const path of slice.files) {
      if (!paths.includes(path)) {
        paths.push(path);
      }
    }
  }

  return paths;
}

function skippedResult(
  turn: Turn,
  rule: ParsedRule,
  reason: "NO_ATTRIBUTED_PATCH" | "NO_SCOPE_MATCH",
): RuleReviewResult {
  return { ...buildReviewContext(turn, rule, []), outcome: "SKIPPED", reason };
}

function unavailableResult(
  turn: Turn,
  rule: ParsedRule,
  reason: "OVERSIZED_DIFF" | "BLOCKED_EVIDENCE",
): RuleReviewResult {
  return { ...buildReviewContext(turn, rule, []), outcome: "UNAVAILABLE", reason };
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
