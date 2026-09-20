import type { JevEvaluationPort, JevEvaluationResult, JevRequest } from "../ports/types";

/**
 * Calls the Jev port once for one request and contains a rejected promise as the
 * shared typed failure. Response validation stays with the port.
 */
export async function evaluateWithPort(
  port: JevEvaluationPort,
  request: JevRequest,
): Promise<JevEvaluationResult> {
  try {
    return await port.evaluate(request);
  } catch {
    return { status: "FAILED", reason: "API_ERROR" };
  }
}
