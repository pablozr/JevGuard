import type { BuiltInReviewContext, GateConfig, Turn } from "../domain/types";
import type { JevNoulQuestion } from "../ports/types";

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
 * Builds the complexity Noul for the shared built-in batch. The check definition
 * travels in the same criteria shape as a rule so one transport serves both.
 */
export function buildComplexityQuestion(): JevNoulQuestion {
  return {
    type: "noul",
    instructions: COMPLEXITY_INSTRUCTIONS,
    criteria: {
      id: COMPLEXITY_CHECK_ID,
      description: COMPLEXITY_DESCRIPTION,
      violation: COMPLEXITY_VIOLATION,
      allowed: COMPLEXITY_ALLOWED,
    },
  };
}

export function buildComplexityContext(
  turn: Turn,
  scopedPaths: readonly string[],
): BuiltInReviewContext {
  return {
    kind: "BUILT_IN",
    turnId: turn.id,
    ruleId: null,
    checkId: COMPLEXITY_CHECK_ID,
    severity: "warning",
    scopedPaths,
  };
}
