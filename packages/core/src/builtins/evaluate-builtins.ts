import type { BuiltInReviewContext, BuiltInReviewResult, RuleEvidence } from "../domain/types";
import { evaluateBuiltInBatchWithPort } from "../evaluation/evaluate-with-port";
import { selectTurnEvidence } from "../evidence/select-evidence";
import { evaluateGate } from "../gate/evaluate-gate";
import type { JevBuiltInAnswerResult, JevBuiltInBatchRequest } from "../ports/types";
import { COMPLEXITY_ANSWER, SCOPE_CREEP_ANSWER, TEST_ADEQUACY_ANSWER } from "../ports/types";
import {
  buildComplexityContext,
  buildComplexityQuestion,
  COMPLEXITY_GATE_CONFIG,
} from "./complexity";
import {
  buildScopeCreepContext,
  buildScopeCreepQuestion,
  SCOPE_CREEP_GATE_CONFIG,
} from "./scope-creep";
import {
  buildTestAdequacyContext,
  buildTestAdequacyQuestion,
  TEST_ADEQUACY_GATE_CONFIG,
} from "./test-adequacy";
import type {
  BuiltInBatchReview,
  EvaluateBuiltInsDependencies,
  EvaluateBuiltInsInput,
} from "./types";

/**
 * Builds the one batch request carrying every independent built-in Noul over the
 * turn's complete evidence. The checks share one task and one change, so the
 * transport issues a single request.
 */
export function buildBuiltInBatchRequest(
  task: string,
  evidence: RuleEvidence,
): JevBuiltInBatchRequest {
  return {
    kind: "BUILT_IN_BATCH",
    task,
    questions: {
      [SCOPE_CREEP_ANSWER]: buildScopeCreepQuestion(),
      [COMPLEXITY_ANSWER]: buildComplexityQuestion(),
      [TEST_ADEQUACY_ANSWER]: buildTestAdequacyQuestion(),
    },
    change: { files: evidence.files, diff: evidence.diff },
  };
}

/**
 * Evaluates every built-in from one selection and at most one batch request. Missing
 * patch skips all of them, blocked or oversized evidence makes all of them
 * `UNAVAILABLE`, and a failed batch makes all of them `UNAVAILABLE`. A usable batch
 * validates each named answer independently: one failed sibling becomes
 * `UNAVAILABLE/JEV_FAILURE` while the others still gate. Scope Creep uses the fixed
 * error gate; Complexity and Test Adequacy use fixed advisory gates and never fail.
 */
export async function evaluateBuiltIns(
  input: EvaluateBuiltInsInput,
  dependencies: EvaluateBuiltInsDependencies,
): Promise<BuiltInBatchReview> {
  const selection = selectTurnEvidence(input.turn, input.evidencePolicy);

  if (selection.status === "SKIPPED") {
    return allBuiltIns(input.turn, [], (context) => ({
      ...context,
      outcome: "SKIPPED",
      reason: selection.reason,
    }));
  }

  if (selection.status === "UNAVAILABLE") {
    return allBuiltIns(input.turn, [], (context) => ({
      ...context,
      outcome: "UNAVAILABLE",
      reason: selection.reason,
    }));
  }

  const evidence = selection.evidence;
  const request = buildBuiltInBatchRequest(input.turn.task, evidence);
  const evaluation = await evaluateBuiltInBatchWithPort(dependencies.jev, request);

  if (evaluation.status === "FAILED") {
    return allBuiltIns(input.turn, evidence.files, (context) => ({
      ...context,
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    }));
  }

  return {
    scopeCreep: gateScopeCreep(evaluation.answers.scopeCreep, input.turn, evidence.files),
    complexity: gateComplexity(evaluation.answers.complexity, input.turn, evidence.files),
    testAdequacy: gateTestAdequacy(evaluation.answers.testAdequacy, input.turn, evidence.files),
  };
}

/** Builds each check's result from its context, so every short-circuit is stated once. */
function allBuiltIns(
  turn: EvaluateBuiltInsInput["turn"],
  scopedPaths: readonly string[],
  result: (context: BuiltInReviewContext) => BuiltInReviewResult,
): BuiltInBatchReview {
  return {
    scopeCreep: result(buildScopeCreepContext(turn, scopedPaths)),
    complexity: result(buildComplexityContext(turn, scopedPaths)),
    testAdequacy: result(buildTestAdequacyContext(turn, scopedPaths)),
  };
}

function gateScopeCreep(
  answer: JevBuiltInAnswerResult,
  turn: EvaluateBuiltInsInput["turn"],
  scopedPaths: readonly string[],
): BuiltInReviewResult {
  const context = buildScopeCreepContext(turn, scopedPaths);

  if (answer.status === "FAILED") {
    return { ...context, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  return {
    ...context,
    ...evaluateGate("error", answer.noul.violationProbability, SCOPE_CREEP_GATE_CONFIG),
  };
}

function gateComplexity(
  answer: JevBuiltInAnswerResult,
  turn: EvaluateBuiltInsInput["turn"],
  scopedPaths: readonly string[],
): BuiltInReviewResult {
  const context = buildComplexityContext(turn, scopedPaths);

  if (answer.status === "FAILED") {
    return { ...context, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  return {
    ...context,
    ...evaluateGate("warning", answer.noul.violationProbability, COMPLEXITY_GATE_CONFIG),
  };
}

function gateTestAdequacy(
  answer: JevBuiltInAnswerResult,
  turn: EvaluateBuiltInsInput["turn"],
  scopedPaths: readonly string[],
): BuiltInReviewResult {
  const context = buildTestAdequacyContext(turn, scopedPaths);

  if (answer.status === "FAILED") {
    return { ...context, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  return {
    ...context,
    ...evaluateGate("warning", answer.noul.violationProbability, TEST_ADEQUACY_GATE_CONFIG),
  };
}
