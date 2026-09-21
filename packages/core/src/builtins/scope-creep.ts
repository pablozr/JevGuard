import type { BuiltInReviewContext, GateConfig, Turn } from "../domain/types";
import type { JevNoulQuestion } from "../ports/types";

export const SCOPE_CREEP_CHECK_ID = "SCOPE-CREEP";

/**
 * Fixed error gate for the scope-creep built-in: a change passes below a 65%
 * violation probability, warns from 65% up to below 90%, and fails at 90% or above,
 * so `.jev/config.yaml` cannot change it.
 */
export const SCOPE_CREEP_GATE_CONFIG: GateConfig = {
  version: 1,
  thresholds: {
    error: { warn: 0.65, fail: 0.9 },
    warning: { warn: 0.6 },
  },
};

const SCOPE_CREEP_INSTRUCTIONS =
  "Answer true when the attributed change contains scope creep: material functional, behavioral, architectural, dependency, configuration, documentation, or refactoring work that the task did not request and that is not reasonably necessary to complete the task. Answer false when every change is requested work, or supporting, testing, or documentation work reasonably necessary to complete the requested work, including immaterial incidental edits. Return the probability from 0 to 1 that the change is scope creep.";

const SCOPE_CREEP_DESCRIPTION =
  "A change is scope creep when it introduces material functional, behavioral, architectural, dependency, configuration, documentation, or refactoring work that the task did not request and that is not reasonably necessary to complete it.";

const SCOPE_CREEP_VIOLATION =
  "The change adds material functional, behavioral, architectural, dependency, configuration, documentation, or refactoring work that the task did not request and that is not reasonably necessary to complete the task.";

const SCOPE_CREEP_ALLOWED =
  "Changes the task requested, and supporting, testing, and documentation changes reasonably necessary to complete the requested work, including immaterial incidental edits.";

/**
 * Builds the scope-creep Noul for the shared built-in batch. The check definition
 * travels in the same criteria shape as a rule so one transport serves both.
 */
export function buildScopeCreepQuestion(): JevNoulQuestion {
  return {
    type: "noul",
    instructions: SCOPE_CREEP_INSTRUCTIONS,
    criteria: {
      id: SCOPE_CREEP_CHECK_ID,
      description: SCOPE_CREEP_DESCRIPTION,
      violation: SCOPE_CREEP_VIOLATION,
      allowed: SCOPE_CREEP_ALLOWED,
    },
  };
}

export function buildScopeCreepContext(
  turn: Turn,
  scopedPaths: readonly string[],
): BuiltInReviewContext {
  return {
    kind: "BUILT_IN",
    turnId: turn.id,
    ruleId: null,
    checkId: SCOPE_CREEP_CHECK_ID,
    severity: "error",
    scopedPaths,
  };
}
