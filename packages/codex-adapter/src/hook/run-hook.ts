import { decodeHookPayload } from "./decode";
import { sessionTaintLine, stepLifecycle } from "./lifecycle";
import { appendHookLog } from "./log";
import {
  appendStateLines,
  dataDirectoryOf,
  readSessionState,
  removeSession,
  sessionDirectoryOf,
  sweepExpiredSessions,
  writeHeartbeat,
} from "./state";
import type {
  CodexHookLogCode,
  CodexSessionState,
  CodexTaintReason,
  CodexTurnEvent,
} from "./types";

/**
 * One hook invocation, start to end: read what the host sent, keep the session's unit in
 * step with it, and write a code about it. It never throws, never writes to stdout or
 * stderr and never produces a verdict — a unit is only ever complete or marked, and this
 * slice has no acquisition to review yet (ADR 0019, F1).
 *
 * The host gives a plugin hook `PLUGIN_DATA`; without it there is nowhere to keep state
 * and the hook says nothing at all.
 */
export interface CodexHookDependencies {
  readonly environment: { get(name: string): string | undefined };
  readonly now: () => Date;
}

const HOST_EVENT_NAME: Readonly<Record<CodexTurnEvent["kind"], string>> = {
  SESSION_START: "SessionStart",
  TURN_OPEN: "UserPromptSubmit",
  TOOL_PRE: "PreToolUse",
  TOOL_POST: "PostToolUse",
  TURN_CLOSE: "Stop",
  SESSION_END: "SessionEnd",
};

/** Whether the session already recorded this mark, so a damaged file is named once. */
function hasTaint(state: CodexSessionState, reason: CodexTaintReason): boolean {
  return (
    state.pendingTaints.includes(reason) || state.units.some((unit) => unit.taints.includes(reason))
  );
}

function failureCode(reason: string): CodexHookLogCode | `PARSE_FAILED:${string}` {
  return reason === "UNSUPPORTED_EVENT" ? "UNSUPPORTED_EVENT" : `PARSE_FAILED:${reason}`;
}

export function runCodexHook(stdin: string, dependencies: CodexHookDependencies): void {
  const pluginData = dependencies.environment.get("PLUGIN_DATA");

  if (pluginData === undefined || pluginData === "") return;

  const dataDirectory = dataDirectoryOf(pluginData);
  const now = dependencies.now();
  const decoded = decodeHookPayload(stdin);
  const hostEvent =
    decoded.status === "EVENT" ? HOST_EVENT_NAME[decoded.event.kind] : (decoded.event ?? "UNKNOWN");
  const log = (code: CodexHookLogCode | `PARSE_FAILED:${string}`): void => {
    appendHookLog(dataDirectory, { v: 1, at: now.toISOString(), event: hostEvent, code });
  };

  if (decoded.status !== "EVENT") {
    log(failureCode(decoded.reason));

    if (decoded.sessionId === null) return;

    const sessionDirectory = sessionDirectoryOf(dataDirectory, decoded.sessionId);
    const reason: CodexTaintReason =
      decoded.reason === "UNSUPPORTED_EVENT" ? "UNSUPPORTED_EVENT" : "PAYLOAD_UNREADABLE";

    try {
      appendStateLines(sessionDirectory, [sessionTaintLine(reason)]);
      writeHeartbeat(sessionDirectory, now);
    } catch {
      log("STATE_WRITE_FAILED");
    }

    return;
  }

  const event = decoded.event;
  const sessionDirectory = sessionDirectoryOf(dataDirectory, event.sessionId);

  if (event.kind === "SESSION_END") {
    removeSession(sessionDirectory);

    return;
  }

  try {
    const state = readSessionState(sessionDirectory);
    const damaged = state.damaged && !hasTaint(state, "STATE_DAMAGED");
    const step = stepLifecycle(state, event, now);
    const lines = damaged ? [sessionTaintLine("STATE_DAMAGED"), ...step.lines] : step.lines;

    if (damaged) log("STATE_READ_FAILED");

    appendStateLines(sessionDirectory, lines);
    writeHeartbeat(sessionDirectory, now);

    if (event.kind === "SESSION_START") sweepExpiredSessions(dataDirectory, now, event.sessionId);

    for (const code of step.codes) log(code);
  } catch {
    log("STATE_WRITE_FAILED");
  }
}
