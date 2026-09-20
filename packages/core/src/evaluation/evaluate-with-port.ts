import type {
  JevBuiltInBatchRequest,
  JevBuiltInBatchResult,
  JevEvaluationPort,
  JevRuleEvaluationResult,
  JevRuleRequest,
} from "../ports/types";

/**
 * Calls the Jev port once for one rule request and contains a rejected promise or a
 * mismatched result as the shared typed failure. Response validation stays with the
 * port.
 */
export async function evaluateWithPort(
  port: JevEvaluationPort,
  request: JevRuleRequest,
): Promise<JevRuleEvaluationResult> {
  try {
    const result = await port.evaluate(request);

    return result.kind === "RULE"
      ? result
      : { kind: "RULE", status: "FAILED", reason: "INVALID_RESPONSE" };
  } catch {
    return { kind: "RULE", status: "FAILED", reason: "API_ERROR" };
  }
}

/**
 * Calls the Jev port once for the built-in batch and contains a rejected promise or
 * a mismatched result as the shared typed failure. Per-answer validation stays with
 * the port.
 */
export async function evaluateBuiltInBatchWithPort(
  port: JevEvaluationPort,
  request: JevBuiltInBatchRequest,
): Promise<JevBuiltInBatchResult> {
  try {
    const result = await port.evaluate(request);

    return result.kind === "BUILT_IN_BATCH"
      ? result
      : { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "INVALID_RESPONSE" };
  } catch {
    return { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "API_ERROR" };
  }
}
