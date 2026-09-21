import type { BuiltInReviewContext, BuiltInReviewResult, RuleEvidence } from "../domain/types";
import { evaluateBuiltInBatchWithPort } from "../evaluation/evaluate-with-port";
import { selectTurnEvidence } from "../evidence/select-evidence";
import { evaluateGate } from "../gate/evaluate-gate";
import type { JevBuiltInAnswerResult, JevBuiltInBatchRequest } from "../ports/types";
import { COMPLEXITY_ANSWER, SCOPE_CREEP_ANSWER } from "../ports/types";
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
import type {
  BuiltInBatchReview,
  EvaluateBuiltInsDependencies,
  EvaluateBuiltInsInput,
} from "./types";

/**
 * Builds the one batch request carrying both independent built-in Nouls over the
 * turn's complete evidence. The two checks share one task and one change, so the
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
    },
    change: { files: evidence.files, diff: evidence.diff },
  };
}

/**
 * Evaluates both built-ins from one selection and at most one batch request. Missing
 * patch skips both, blocked or oversized evidence makes both `UNAVAILABLE`, and a
 * failed batch makes both `UNAVAILABLE`. A usable batch validates each named answer
 * independently: one failed sibling becomes `UNAVAILABLE/JEV_FAILURE` while the other
 * still gates. Scope Creep uses the fixed error gate; Complexity uses the fixed
 * advisory gate and never fails.
 */
export async function evaluateBuiltIns(
  input: EvaluateBuiltInsInput,
  dependencies: EvaluateBuiltInsDependencies,
): Promise<BuiltInBatchReview> {
  const selection = selectTurnEvidence(input.turn, input.evidencePolicy);

  if (selection.status === "SKIPPED") {
    return {
      scopeCreep: {
        ...buildScopeCreepContext(input.turn, []),
        outcome: "SKIPPED",
        reason: selection.reason,
      },
      complexity: {
        ...buildComplexityContext(input.turn, []),
        outcome: "SKIPPED",
        reason: selection.reason,
      },
    };
  }

  if (selection.status === "UNAVAILABLE") {
    return {
      scopeCreep: {
        ...buildScopeCreepContext(input.turn, []),
        outcome: "UNAVAILABLE",
        reason: selection.reason,
      },
      complexity: {
        ...buildComplexityContext(input.turn, []),
        outcome: "UNAVAILABLE",
        reason: selection.reason,
      },
    };
  }

  const evidence = selection.evidence;
  const request = buildBuiltInBatchRequest(input.turn.task, evidence);
  const evaluation = await evaluateBuiltInBatchWithPort(dependencies.jev, request);

  const scopeCreepContext = buildScopeCreepContext(input.turn, evidence.files);
  const complexityContext = buildComplexityContext(input.turn, evidence.files);

  if (evaluation.status === "FAILED") {
    return {
      scopeCreep: { ...scopeCreepContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
      complexity: { ...complexityContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
    };
  }

  return {
    scopeCreep: gateScopeCreep(evaluation.answers.scopeCreep, scopeCreepContext),
    complexity: gateComplexity(evaluation.answers.complexity, complexityContext),
  };
}

function gateScopeCreep(
  answer: JevBuiltInAnswerResult,
  context: BuiltInReviewContext,
): BuiltInReviewResult {
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
  context: BuiltInReviewContext,
): BuiltInReviewResult {
  if (answer.status === "FAILED") {
    return { ...context, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  return {
    ...context,
    ...evaluateGate("warning", answer.noul.violationProbability, COMPLEXITY_GATE_CONFIG),
  };
}
