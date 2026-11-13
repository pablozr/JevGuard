/** Execution lifecycle events the plugin subscribes to, in the 2.2.x `data` shape. */
export const TURN_EVENT_TYPES = [
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.interrupted",
  "session.execution.failed",
] as const;

/** Why an execution ended without success; such an execution is never reviewed. */
export type TurnEndReason = "interrupted" | "failed";

export type TurnEvent =
  | { readonly kind: "STARTED"; readonly sessionID: string }
  | { readonly kind: "SUCCEEDED"; readonly sessionID: string }
  | { readonly kind: "ENDED_OTHER"; readonly sessionID: string; readonly reason: TurnEndReason };

/**
 * Reads one execution lifecycle event. A review unit is one execution: `started`
 * opens it, only `succeeded` reviews it, and `interrupted`/`failed` discard it. Any
 * other event, a V1 `properties` payload, or a missing session ID yields `null`.
 */
export function parseTurnEvent(event: unknown): TurnEvent | null {
  if (!isRecord(event) || !isRecord(event.data)) {
    return null;
  }

  const sessionID = event.data.sessionID;

  if (typeof sessionID !== "string" || sessionID === "") {
    return null;
  }

  switch (event.type) {
    case "session.execution.started":
      return { kind: "STARTED", sessionID };
    case "session.execution.succeeded":
      return { kind: "SUCCEEDED", sessionID };
    case "session.execution.interrupted":
      return { kind: "ENDED_OTHER", sessionID, reason: "interrupted" };
    case "session.execution.failed":
      return { kind: "ENDED_OTHER", sessionID, reason: "failed" };
    default:
      return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
