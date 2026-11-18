import type { CodexDecodeFailure, CodexTurnEvent } from "./types";

/**
 * Turns one host payload into a turn event, or refuses it with a closed reason.
 *
 * The reading is deliberately closed (ADR 0019): only the six events the F0 capture
 * proved are understood, and each one must carry the ids a unit needs. A host that
 * changes its payload therefore falls out here — the session is marked and every unit of
 * it can only end `UNAVAILABLE` — instead of being read as if nothing had happened.
 *
 * What the payload carries beyond identity is dropped, not stored: `prompt`,
 * `last_assistant_message`, `transcript_path`, `cwd`, `tool_input` and `tool_response`
 * never leave this function.
 */

export type CodexDecodeResult =
  | { readonly status: "EVENT"; readonly event: CodexTurnEvent }
  | {
      readonly status: "FAILED";
      readonly reason: CodexDecodeFailure;
      /** The host's session id, only when it is readable; never logged. */
      readonly sessionId: string | null;
      /** The host's event name, from the closed set, only when it is one of them. */
      readonly event: string | null;
    };

const EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
] as const;

type KnownEventName = (typeof EVENT_NAMES)[number];

function isKnownEventName(value: unknown): value is KnownEventName {
  return typeof value === "string" && (EVENT_NAMES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];

  return typeof value === "string" && value !== "" ? value : null;
}

function rejected(
  reason: CodexDecodeFailure,
  record: Record<string, unknown> | null,
): CodexDecodeResult {
  const name = record?.hook_event_name;

  return {
    status: "FAILED",
    reason,
    sessionId: record === null ? null : nonEmptyString(record, "session_id"),
    event: isKnownEventName(name) ? name : null,
  };
}

function sessionEvent(name: "SessionStart" | "SessionEnd", sessionId: string): CodexDecodeResult {
  return {
    status: "EVENT",
    event: { kind: name === "SessionStart" ? "SESSION_START" : "SESSION_END", sessionId },
  };
}

function turnEvent(
  name: "UserPromptSubmit" | "Stop",
  sessionId: string,
  turnId: string,
): CodexDecodeResult {
  return {
    status: "EVENT",
    event: {
      kind: name === "UserPromptSubmit" ? "TURN_OPEN" : "TURN_CLOSE",
      sessionId,
      turnId,
    },
  };
}

function callEvent(
  name: "PreToolUse" | "PostToolUse",
  sessionId: string,
  turnId: string,
  toolUseId: string,
): CodexDecodeResult {
  return {
    status: "EVENT",
    event: {
      kind: name === "PreToolUse" ? "TOOL_PRE" : "TOOL_POST",
      sessionId,
      turnId,
      toolUseId,
    },
  };
}

function parseJson(stdin: string): unknown {
  try {
    return JSON.parse(stdin);
  } catch {
    return undefined;
  }
}

/** The whole decoding of one hook invocation's stdin. */
export function decodeHookPayload(stdin: string): CodexDecodeResult {
  const payload = parseJson(stdin);

  if (payload === undefined) return rejected("NOT_JSON", null);

  if (!isRecord(payload)) return rejected("NOT_OBJECT", null);

  const sessionId = nonEmptyString(payload, "session_id");

  if (sessionId === null) return rejected("MISSING_SESSION_ID", payload);

  const name = payload.hook_event_name;

  // A host event outside this slice (a subagent, a compaction, a future hook) may carry
  // a write nobody can attribute yet, so it marks the session instead of being ignored.
  if (!isKnownEventName(name)) return rejected("UNSUPPORTED_EVENT", payload);

  if (name === "SessionStart" || name === "SessionEnd") return sessionEvent(name, sessionId);

  const turnId = nonEmptyString(payload, "turn_id");

  if (turnId === null) return rejected("MISSING_TURN_ID", payload);

  if (name === "UserPromptSubmit" || name === "Stop") return turnEvent(name, sessionId, turnId);

  const toolUseId = nonEmptyString(payload, "tool_use_id");

  if (toolUseId === null) return rejected("MISSING_TOOL_USE_ID", payload);

  return callEvent(name, sessionId, turnId, toolUseId);
}
