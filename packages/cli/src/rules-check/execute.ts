import { checkRules, parseUnifiedDiff } from "@jevguard/core";
import type { RulesCheckDependencies, RulesCheckRequest, RulesCheckResult } from "./types";

export const RULES_CHECK_TURN_ID = "rules-check";

export const RULES_CHECK_DEFAULT_TASK =
  "No task was provided. Judge the change against the rule on its own.";

/**
 * Runs one on-demand rule check: read and split the provided diff, then evaluate only
 * the repository rules over it through the core `checkRules` use case. An unreadable
 * or unrecognized diff never reaches Jev.
 */
export async function executeRulesCheck(
  request: RulesCheckRequest,
  dependencies: RulesCheckDependencies,
): Promise<RulesCheckResult> {
  const read = await dependencies.readDiff(request.diff);

  if (read.status === "FAILED") {
    return { status: "INPUT_FAILED", reason: read.reason };
  }

  const parsed = parseUnifiedDiff(read.text);

  if (parsed.status === "INVALID") {
    return { status: "INPUT_FAILED", reason: parsed.reason };
  }

  const turn = {
    id: RULES_CHECK_TURN_ID,
    task: request.task ?? RULES_CHECK_DEFAULT_TASK,
    files: parsed.files,
  };

  return checkRules(
    { turn, ruleId: request.ruleId },
    {
      policy: dependencies.policy,
      parseConfig: dependencies.parseConfig,
      jev: dependencies.jev,
    },
  );
}
