import type {
  JevBuiltInBatchRequest,
  JevBuiltInBatchResult,
  JevEvaluationPort,
  JevFailureReason,
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
 * Calls the Jev port once for a whole turn's rule slices and contains a rejected
 * promise or any mismatched result as one typed failure per request. Results are
 * already in input order; a length mismatch fails every request rather than trusting a
 * partial response, and per-request validation stays with the port.
 */
export async function evaluateRuleBatchWithPort(
  port: JevEvaluationPort,
  requests: readonly JevRuleRequest[],
): Promise<readonly JevRuleEvaluationResult[]> {
  try {
    const results = await port.evaluateRuleBatch(requests);

    if (results.length !== requests.length) {
      return requests.map(() => ruleFailure("INVALID_RESPONSE"));
    }

    return results.map((result) =>
      result.kind === "RULE" ? result : ruleFailure("INVALID_RESPONSE"),
    );
  } catch {
    return requests.map(() => ruleFailure("API_ERROR"));
  }
}

function ruleFailure(reason: JevFailureReason): JevRuleEvaluationResult {
  return { kind: "RULE", status: "FAILED", reason };
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
