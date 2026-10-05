import { isJsonObject, readShellEditDiff } from "./shell-diff";
import { categorizeTool } from "./tool-category";
import type {
  BackgroundTasksState,
  HookEvent,
  HookEventBase,
  HookEventParseFailure,
  HookEventParseReason,
  JsonObject,
  ShellEditDiff,
  ToolCall,
} from "./types";

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: HookEventParseFailure };

function fail(reason: HookEventParseReason, field: string): HookEventParseFailure {
  return { invalid: true, reason, field };
}

function requiredString(payload: JsonObject, field: string): Parsed<string> {
  const value = payload[field];

  if (value === undefined) return { ok: false, failure: fail("MISSING_FIELD", field) };
  if (typeof value !== "string" || value === "") {
    return { ok: false, failure: fail("INVALID_FIELD", field) };
  }

  return { ok: true, value };
}

function optionalString(payload: JsonObject, field: string): Parsed<string | null> {
  const value = payload[field];

  if (value === undefined) return { ok: true, value: null };
  if (typeof value !== "string" || value === "") {
    return { ok: false, failure: fail("INVALID_FIELD", field) };
  }

  return { ok: true, value };
}

function parseBase(payload: JsonObject): Parsed<HookEventBase> {
  const sessionId = requiredString(payload, "session_id");
  if (!sessionId.ok) return sessionId;

  const cwd = requiredString(payload, "cwd");
  if (!cwd.ok) return cwd;

  const promptId = optionalString(payload, "prompt_id");
  if (!promptId.ok) return promptId;

  const agentId = optionalString(payload, "agent_id");
  if (!agentId.ok) return agentId;

  return {
    ok: true,
    value: {
      sessionId: sessionId.value,
      cwd: cwd.value,
      promptId: promptId.value,
      agentId: agentId.value,
    },
  };
}

function editPath(toolInput: JsonObject | null): string | null {
  if (toolInput === null) return null;

  for (const key of ["file_path", "notebook_path"]) {
    const value = toolInput[key];

    if (typeof value === "string" && value !== "") return value;
  }

  return null;
}

function parseTool(payload: JsonObject): Parsed<ToolCall> {
  const toolName = requiredString(payload, "tool_name");
  if (!toolName.ok) return toolName;

  const toolUseId = requiredString(payload, "tool_use_id");
  if (!toolUseId.ok) return toolUseId;

  const rawInput = payload.tool_input;

  if (rawInput !== undefined && !isJsonObject(rawInput)) {
    return { ok: false, failure: fail("INVALID_FIELD", "tool_input") };
  }

  const toolInput = rawInput === undefined ? null : rawInput;
  const category = categorizeTool(toolName.value);
  const isShell = category === "BASH" || category === "POWERSHELL";

  return {
    ok: true,
    value: {
      toolName: toolName.value,
      category,
      toolUseId: toolUseId.value,
      filePath: category === "EDIT" ? editPath(toolInput) : null,
      runInBackground: isShell && toolInput?.run_in_background === true,
    },
  };
}

function backgroundTasksState(value: unknown): BackgroundTasksState {
  if (Array.isArray(value)) return value.length > 0 ? "ACTIVE" : "EMPTY";
  if (isJsonObject(value)) return Object.keys(value).length > 0 ? "ACTIVE" : "EMPTY";

  return "UNKNOWN";
}

function parseStopHookActive(payload: JsonObject): Parsed<boolean> {
  const value = payload.stop_hook_active;

  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== "boolean") {
    return { ok: false, failure: fail("INVALID_FIELD", "stop_hook_active") };
  }

  return { ok: true, value };
}

function parseEvent(
  name: string,
  base: HookEventBase,
  payload: JsonObject,
): HookEvent | HookEventParseFailure {
  switch (name) {
    case "SessionStart":
    case "SessionEnd":
    case "SubagentStart":
    case "SubagentStop":
    case "StopFailure":
      return { ...base, name };
    case "UserPromptSubmit": {
      const prompt = payload.prompt;

      return { ...base, name, prompt: typeof prompt === "string" ? prompt : null };
    }
    case "PreToolUse":
    case "PostToolUseFailure": {
      const tool = parseTool(payload);

      return tool.ok ? { ...base, name, tool: tool.value } : tool.failure;
    }
    case "PostToolUse": {
      const tool = parseTool(payload);

      if (!tool.ok) return tool.failure;

      const absent: ShellEditDiff = { status: "ABSENT" };
      const shellDiff =
        tool.value.category === "BASH" ? readShellEditDiff(payload.tool_response) : absent;

      return { ...base, name, tool: tool.value, shellDiff };
    }
    case "Stop": {
      const stopHookActive = parseStopHookActive(payload);

      if (!stopHookActive.ok) return stopHookActive.failure;

      return {
        ...base,
        name,
        backgroundTasks: backgroundTasksState(payload.background_tasks),
        stopHookActive: stopHookActive.value,
      };
    }
    default:
      return fail("UNKNOWN_EVENT", "hook_event_name");
  }
}

export function isHookEventParseFailure(
  result: HookEvent | HookEventParseFailure,
): result is HookEventParseFailure {
  return "invalid" in result;
}

/** Strict normalization of an untrusted hook payload; failures name fields, never values. */
export function parseHookEvent(payload: unknown): HookEvent | HookEventParseFailure {
  if (!isJsonObject(payload)) return fail("NOT_AN_OBJECT", "payload");

  const name = requiredString(payload, "hook_event_name");
  if (!name.ok) return name.failure;

  const base = parseBase(payload);
  if (!base.ok) return base.failure;

  return parseEvent(name.value, base.value, payload);
}
