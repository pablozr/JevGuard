import type {
  BuiltInReviewContext,
  BuiltInReviewResult,
  GateConfig,
  RuleEvidence,
  Turn,
} from "../domain/types";
import { selectTurnEvidence } from "../evidence/select-evidence";
import { evaluateWithPort } from "../evaluation/evaluate-with-port";
import { evaluateGate } from "../gate/evaluate-gate";
import type { JevBuiltInRequest } from "../ports/types";
import type { EvaluateComplexityDependencies, EvaluateComplexityInput } from "./types";

export const COMPLEXITY_CHECK_ID = "COMPLEXITY";

/**
 * Fixed advisory gate for the complexity built-in: a change is flagged at a 50%
 * violation probability and can never fail, so `.jev/config.yaml` cannot change it.
 */
export const COMPLEXITY_GATE_CONFIG: GateConfig = {
  version: 1,
  thresholds: {
    error: { warn: 0.4, fail: 0.7 },
    warning: { warn: 0.5 },
  },
};

const COMPLEXITY_INSTRUCTIONS =
  "Does this attributed change introduce material complexity that is disproportionate to, or not reasonably necessary for, completing the user's task? Necessary supporting changes, tests, validation, error handling, and complexity explicitly required by the task should not count as unnecessary complexity. Return the probability from 0 to 1 that the change introduces disproportionate or unnecessary complexity.";

const COMPLEXITY_DESCRIPTION =
  "Material complexity introduced by the attributed change that is disproportionate to the problem and not reasonably necessary for completing the task.";

const COMPLEXITY_VIOLATION =
  "The change adds unnecessary abstractions, layers or indirections without proportional gain, new dependencies without clear need, excessive configuration, premature generalization, or structure materially larger than the problem requires.";

const COMPLEXITY_ALLOWED =
  "Complexity explicitly required by the task, and necessary supporting changes, tests, validation, error handling, auxiliary changes, or following an existing codebase abstraction to avoid breaking its pattern.";

/**
 * Builds the single Noul request for the complexity built-in over the turn's
 * complete attributed evidence. The check definition travels in the same criteria
 * shape as a rule so one transport serves every lane.
 */
export function buildComplexityRequest(task: string, evidence: RuleEvidence): JevBuiltInRequest {
  return {
    kind: "BUILT_IN",
    task,
    question: {
      type: "noul",
      instructions: COMPLEXITY_INSTRUCTIONS,
      criteria: {
        id: COMPLEXITY_CHECK_ID,
        description: COMPLEXITY_DESCRIPTION,
        violation: COMPLEXITY_VIOLATION,
        allowed: COMPLEXITY_ALLOWED,
      },
    },
    change: { files: evidence.files, diff: evidence.diff },
  };
}

/**
 * Evaluates complexity for one turn: select the complete scope-free evidence, call
 * Jev at most once, and gate the probability through the fixed advisory thresholds.
 * Missing patch, oversized, blocked, and port failures stay operational and never
 * become a semantic verdict. The check is warning-only, so it can never produce
 * `FAIL`.
 */
export async function evaluateComplexity(
  input: EvaluateComplexityInput,
  dependencies: EvaluateComplexityDependencies,
): Promise<BuiltInReviewResult> {
  const selection = selectTurnEvidence(input.turn, input.evidencePolicy);

  if (selection.status === "SKIPPED") {
    return {
      ...buildComplexityContext(input.turn, []),
      outcome: "SKIPPED",
      reason: selection.reason,
    };
  }

  if (selection.status === "UNAVAILABLE") {
    return {
      ...buildComplexityContext(input.turn, []),
      outcome: "UNAVAILABLE",
      reason: selection.reason,
    };
  }

  const context = buildComplexityContext(input.turn, selection.evidence.files);
  const request = buildComplexityRequest(input.turn.task, selection.evidence);
  const evaluation = await evaluateWithPort(dependencies.jev, request);

  if (evaluation.status === "FAILED") {
    return { ...context, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  const gate = evaluateGate(
    "warning",
    evaluation.noul.violationProbability,
    COMPLEXITY_GATE_CONFIG,
  );

  return { ...context, ...gate };
}

function buildComplexityContext(turn: Turn, scopedPaths: readonly string[]): BuiltInReviewContext {
  return {
    kind: "BUILT_IN",
    turnId: turn.id,
    ruleId: null,
    checkId: COMPLEXITY_CHECK_ID,
    severity: "warning",
    scopedPaths,
  };
}
