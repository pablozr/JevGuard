import type {
  BuiltInReviewContext,
  BuiltInReviewResult,
  RuleEvidence,
  Turn,
} from "../domain/types";
import { selectTurnEvidence } from "../evidence/select-evidence";
import { evaluateWithPort } from "../evaluation/evaluate-with-port";
import { DEFAULT_GATE_CONFIG } from "../gate/defaults";
import { evaluateGate } from "../gate/evaluate-gate";
import type { JevBuiltInRequest } from "../ports/types";
import type { EvaluateScopeCreepDependencies, EvaluateScopeCreepInput } from "./types";

export const SCOPE_CREEP_CHECK_ID = "SCOPE-CREEP";

const SCOPE_CREEP_INSTRUCTIONS =
  "Answer true when the attributed change contains scope creep: material functional, behavioral, architectural, dependency, configuration, documentation, or refactoring work that the task did not request and that is not reasonably necessary to complete the task. Answer false when every change is requested work, or supporting, testing, or documentation work reasonably necessary to complete the requested work, including immaterial incidental edits. Return the probability from 0 to 1 that the change is scope creep.";

const SCOPE_CREEP_DESCRIPTION =
  "A change is scope creep when it introduces material functional, behavioral, architectural, dependency, configuration, documentation, or refactoring work that the task did not request and that is not reasonably necessary to complete it.";

const SCOPE_CREEP_VIOLATION =
  "The change adds material functional, behavioral, architectural, dependency, configuration, documentation, or refactoring work that the task did not request and that is not reasonably necessary to complete the task.";

const SCOPE_CREEP_ALLOWED =
  "Changes the task requested, and supporting, testing, and documentation changes reasonably necessary to complete the requested work, including immaterial incidental edits.";

/**
 * Builds the single Noul request for the scope-creep built-in over the turn's
 * complete attributed evidence. The check definition travels in the same criteria
 * shape as a rule so one transport serves both.
 */
export function buildScopeCreepRequest(task: string, evidence: RuleEvidence): JevBuiltInRequest {
  return {
    kind: "BUILT_IN",
    task,
    question: {
      type: "noul",
      instructions: SCOPE_CREEP_INSTRUCTIONS,
      criteria: {
        id: SCOPE_CREEP_CHECK_ID,
        description: SCOPE_CREEP_DESCRIPTION,
        violation: SCOPE_CREEP_VIOLATION,
        allowed: SCOPE_CREEP_ALLOWED,
      },
    },
    change: { files: evidence.files, diff: evidence.diff },
  };
}

/**
 * Evaluates scope creep for one turn: select the complete scope-free evidence,
 * call Jev at most once, and gate the probability through the fixed error
 * thresholds. Missing patch, oversized, blocked, and port failures stay operational
 * and never become a semantic verdict.
 */
export async function evaluateScopeCreep(
  input: EvaluateScopeCreepInput,
  dependencies: EvaluateScopeCreepDependencies,
): Promise<BuiltInReviewResult> {
  const selection = selectTurnEvidence(input.turn, input.evidencePolicy);

  if (selection.status === "SKIPPED") {
    return {
      ...buildScopeCreepContext(input.turn, []),
      outcome: "SKIPPED",
      reason: selection.reason,
    };
  }

  if (selection.status === "UNAVAILABLE") {
    return {
      ...buildScopeCreepContext(input.turn, []),
      outcome: "UNAVAILABLE",
      reason: selection.reason,
    };
  }

  const context = buildScopeCreepContext(input.turn, selection.evidence.files);
  const request = buildScopeCreepRequest(input.turn.task, selection.evidence);
  const evaluation = await evaluateWithPort(dependencies.jev, request);

  if (evaluation.status === "FAILED") {
    return { ...context, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  const gate = evaluateGate("error", evaluation.noul.violationProbability, DEFAULT_GATE_CONFIG);

  return { ...context, ...gate };
}

function buildScopeCreepContext(turn: Turn, scopedPaths: readonly string[]): BuiltInReviewContext {
  return {
    kind: "BUILT_IN",
    turnId: turn.id,
    ruleId: null,
    checkId: SCOPE_CREEP_CHECK_ID,
    severity: "error",
    scopedPaths,
  };
}
