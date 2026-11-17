import type { BuiltInReviewContext, GateConfig, Turn } from "../domain/types";
import type { JevNoulQuestion } from "../ports/types";

export const TEST_ADEQUACY_CHECK_ID = "TEST-ADEQUACY";

/**
 * Fixed advisory gate for the test-adequacy built-in: a change is flagged at a 60%
 * violation probability and can never fail, so `.jev/config.yaml` cannot change it.
 * Whether a change is tested enough is a judgment about something absent from the
 * patch, the least reliable of the three built-ins, so it never blocks a turn.
 */
export const TEST_ADEQUACY_GATE_CONFIG: GateConfig = {
  version: 1,
  thresholds: {
    error: { warn: 0.6, fail: 0.9 },
    warning: { warn: 0.6 },
  },
};

const TEST_ADEQUACY_INSTRUCTIONS =
  "Answer true when the attributed change adds or changes behavior that no test it adds or updates exercises. Answer false when the change adds or updates a test exercising the behavior it adds or changes, when it changes no behavior (documentation, comments, formatting, type-only changes, or a behavior-preserving refactor), or when tests the change does not touch already exercise that behavior. Return the probability from 0 to 1 that the change is inadequately tested.";

const TEST_ADEQUACY_DESCRIPTION =
  "Behavior added or changed by the attributed change that the change does not cover with a test exercising it.";

const TEST_ADEQUACY_VIOLATION =
  "The change adds or changes behavior — a new branch, endpoint, command, option, error path, or altered output — without adding or updating a test that exercises it.";

const TEST_ADEQUACY_ALLOWED =
  "Changes that add or update a test for the behavior they add or change, changes with no behavior (documentation, comments, formatting, type-only edits, or a behavior-preserving refactor), and changes whose behavior is already exercised by tests they do not need to touch.";

/**
 * Builds the test-adequacy Noul for the shared built-in batch. The check definition
 * travels in the same criteria shape as a rule so one transport serves every check.
 */
export function buildTestAdequacyQuestion(): JevNoulQuestion {
  return {
    type: "noul",
    instructions: TEST_ADEQUACY_INSTRUCTIONS,
    criteria: {
      id: TEST_ADEQUACY_CHECK_ID,
      description: TEST_ADEQUACY_DESCRIPTION,
      violation: TEST_ADEQUACY_VIOLATION,
      allowed: TEST_ADEQUACY_ALLOWED,
    },
  };
}

export function buildTestAdequacyContext(
  turn: Turn,
  scopedPaths: readonly string[],
): BuiltInReviewContext {
  return {
    kind: "BUILT_IN",
    turnId: turn.id,
    ruleId: null,
    checkId: TEST_ADEQUACY_CHECK_ID,
    severity: "warning",
    scopedPaths,
  };
}
