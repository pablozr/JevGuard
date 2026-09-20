/**
 * Reads the one host event this plugin reacts to: an idle `session.status`. Any
 * other event, including the separate `session.idle` event, is ignored.
 */
export function idleSessionID(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "session.status") {
    return null;
  }

  const properties = event.properties;

  if (!isRecord(properties)) {
    return null;
  }

  const status = properties.status;

  if (!isRecord(status) || status.type !== "idle") {
    return null;
  }

  const sessionID = properties.sessionID;

  return typeof sessionID === "string" && sessionID !== "" ? sessionID : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
