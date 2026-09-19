import type { ReviewResult } from "../domain/types";
import { selectRuleEvidence } from "../evidence/select-evidence";
import { evaluateGate } from "../gate/evaluate-gate";
import type { JevEvaluationPort, JevEvaluationResult, JevRequest } from "../ports/types";
import { buildJevRequest } from "./build-request";
import { buildReviewContext } from "./build-context";
import type { EvaluateRuleDependencies, EvaluateRuleInput } from "./types";

/**
 * Orchestrates one rule's evaluation: select complete evidence, call the Jev port
 * at most once with one Noul request, and convert the response into a local gate
 * outcome. Evidence short-circuits and port failures are operational states and
 * never reach a semantic verdict.
 */
export async function evaluateRule(
  input: EvaluateRuleInput,
  dependencies: EvaluateRuleDependencies,
): Promise<ReviewResult> {
  const selection = selectRuleEvidence(input.turn, input.rule, input.evidencePolicy);

  if (selection.status === "SKIPPED") {
    const context = buildReviewContext(input.turn, input.rule, []);
    return { ...context, outcome: "SKIPPED", reason: selection.reason };
  }

  if (selection.status === "UNAVAILABLE") {
    const context = buildReviewContext(input.turn, input.rule, []);
    return { ...context, outcome: "UNAVAILABLE", reason: selection.reason };
  }

  const context = buildReviewContext(input.turn, input.rule, selection.evidence.files);
  const request = buildJevRequest(input.turn.task, input.rule, selection.evidence);
  const evaluation = await evaluateWithPort(dependencies.jev, request);

  if (evaluation.status === "FAILED") {
    return { ...context, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  const gate = evaluateGate(
    input.rule.severity,
    evaluation.noul.violationProbability,
    input.gateConfig,
  );

  return { ...context, ...gate };
}

async function evaluateWithPort(
  port: JevEvaluationPort,
  request: JevRequest,
): Promise<JevEvaluationResult> {
  try {
    return await port.evaluate(request);
  } catch {
    return { status: "FAILED", reason: "API_ERROR" };
  }
}
