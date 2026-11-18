import { decodeHookPayload } from "./decode";
import { sessionTaintLine, stepLifecycle } from "./lifecycle";
import { appendHookLog } from "./log";
import {
  appendStateLines,
  boundStateFile,
  dataDirectoryOf,
  readSessionState,
  removeSession,
  sessionDirectoryOf,
  sweepExpiredSessions,
  writeHeartbeat,
} from "./state";
import type { CodexHookLogCode, CodexTaintReason, CodexTurnEvent } from "./types";

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

    // Bounding the file rewrites it, so it only runs where no unit is open: a line another
    // hook appends for an open unit would be lost with it. Damage stays where it fell.
    boundStateFile(sessionDirectory, state);

    const step = stepLifecycle(state, event, now);

    appendStateLines(sessionDirectory, step.lines);
    writeHeartbeat(sessionDirectory, now);

    if (event.kind === "SESSION_START") sweepExpiredSessions(dataDirectory, now, event.sessionId);

    for (const code of step.codes) log(code);
  } catch {
    log("STATE_WRITE_FAILED");
  }
}
