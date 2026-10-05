import { isJsonObject } from "./shell-diff";
import { categorizeTool } from "./tool-category";
import type {
  BackgroundTasksState,
  HookEvent,
  HookEventBase,
  HookEventName,
  HookEventParseFailure,
  HookEventParseReason,
  JsonObject,
  ShellEditDiff,
  ToolCall,
} from "./types";

interface Rejected {
  readonly ok: false;
  readonly failure: HookEventParseFailure;
}

type Decoded<T> = { readonly ok: true; readonly value: T } | Rejected;

const BASE_KEYS: readonly string[] = ["name", "sessionId", "cwd", "promptId", "agentId"];
const TOOL_KEYS: readonly string[] = [
  "toolName",
  "category",
  "toolUseId",
  "filePath",
  "runInBackground",
];
const EVENT_NAMES: readonly HookEventName[] = [
  "SessionStart",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
  "StopFailure",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUseFailure",
  "PostToolUse",
  "Stop",
];

const EXTRA_KEYS: Readonly<Record<HookEventName, readonly string[]>> = {
  SessionStart: [],
  SessionEnd: [],
  SubagentStart: [],
  SubagentStop: [],
  StopFailure: [],
  UserPromptSubmit: ["prompt"],
  PreToolUse: ["tool"],
  PostToolUseFailure: ["tool"],
  PostToolUse: ["tool", "shellDiff"],
  Stop: ["backgroundTasks", "stopHookActive"],
};

function failed(reason: HookEventParseReason, field: string): Rejected {
  return { ok: false, failure: { invalid: true, reason, field } };
}

function ok<T>(value: T): Decoded<T> {
  return { ok: true, value };
}

function hasExactKeys(value: JsonObject, keys: readonly string[]): boolean {
  const actual = Object.keys(value);

  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function nullableString(object: JsonObject, field: string): Decoded<string | null> {
  const value = object[field];

  if (value === null) return ok(null);

  return nonEmptyString(value) ? ok(value) : failed("INVALID_FIELD", field);
}

function decodeBase(object: JsonObject, name: HookEventName): Decoded<HookEventBase> {
  if (!hasExactKeys(object, [...BASE_KEYS, ...EXTRA_KEYS[name]])) {
    return failed("INVALID_FIELD", "event");
  }

  const { sessionId, cwd } = object;

  if (!nonEmptyString(sessionId)) return failed("INVALID_FIELD", "sessionId");
  if (!nonEmptyString(cwd)) return failed("INVALID_FIELD", "cwd");

  const promptId = nullableString(object, "promptId");
  if (!promptId.ok) return promptId;

  const agentId = nullableString(object, "agentId");
  if (!agentId.ok) return agentId;

  return ok({ sessionId, cwd, promptId: promptId.value, agentId: agentId.value });
}

function decodeTool(value: unknown): Decoded<ToolCall> {
  if (!isJsonObject(value) || !hasExactKeys(value, TOOL_KEYS)) {
    return failed("INVALID_FIELD", "tool");
  }

  const { toolName, toolUseId, runInBackground } = value;

  if (!nonEmptyString(toolName)) return failed("INVALID_FIELD", "toolName");
  if (!nonEmptyString(toolUseId)) return failed("INVALID_FIELD", "toolUseId");

  const category = categorizeTool(toolName);

  if (value.category !== category) return failed("INVALID_FIELD", "category");

  const filePath = nullableString(value, "filePath");
  if (!filePath.ok) return filePath;
  if (filePath.value !== null && category !== "EDIT") return failed("INVALID_FIELD", "filePath");

  const isShell = category === "BASH" || category === "POWERSHELL";

  if (typeof runInBackground !== "boolean" || (runInBackground && !isShell)) {
    return failed("INVALID_FIELD", "runInBackground");
  }

  return ok({ toolName, category, toolUseId, filePath: filePath.value, runInBackground });
}

function decodeShellDiff(value: unknown): Decoded<ShellEditDiff> {
  if (!isJsonObject(value)) return failed("INVALID_FIELD", "shellDiff");

  if (value.status === "ABSENT" || value.status === "INCOMPLETE") {
    return hasExactKeys(value, ["status"])
      ? ok({ status: value.status })
      : failed("INVALID_FIELD", "shellDiff");
  }

  const changed = value.changedFiles;

  if (value.status !== "PRESENT" || !hasExactKeys(value, ["status", "changedFiles"])) {
    return failed("INVALID_FIELD", "shellDiff");
  }

  if (!Array.isArray(changed) || !changed.every(nonEmptyString)) {
    return failed("INVALID_FIELD", "changedFiles");
  }

  return ok({ status: "PRESENT", changedFiles: changed });
}

function backgroundState(value: unknown): BackgroundTasksState | null {
  if (value === "EMPTY" || value === "ACTIVE" || value === "UNKNOWN") return value;

  return null;
}

function decodeBody(
  object: JsonObject,
  name: HookEventName,
  base: HookEventBase,
): Decoded<HookEvent> {
  switch (name) {
    case "SessionStart":
    case "SessionEnd":
    case "SubagentStart":
    case "SubagentStop":
    case "StopFailure":
      return ok({ ...base, name });
    case "UserPromptSubmit": {
      const prompt = object.prompt;

      if (prompt !== null && typeof prompt !== "string") return failed("INVALID_FIELD", "prompt");

      return ok({ ...base, name, prompt });
    }
    case "PreToolUse":
    case "PostToolUseFailure": {
      const tool = decodeTool(object.tool);

      return tool.ok ? ok({ ...base, name, tool: tool.value }) : tool;
    }
    case "PostToolUse": {
      const tool = decodeTool(object.tool);
      if (!tool.ok) return tool;

      const shellDiff = decodeShellDiff(object.shellDiff);
      if (!shellDiff.ok) return shellDiff;

      return ok({ ...base, name, tool: tool.value, shellDiff: shellDiff.value });
    }
    case "Stop": {
      const backgroundTasks = backgroundState(object.backgroundTasks);

      if (backgroundTasks === null) return failed("INVALID_FIELD", "backgroundTasks");
      if (typeof object.stopHookActive !== "boolean") {
        return failed("INVALID_FIELD", "stopHookActive");
      }

      return ok({ ...base, name, backgroundTasks, stopHookActive: object.stopHookActive });
    }
  }
}

function eventName(value: unknown): HookEventName | null {
  for (const name of EVENT_NAMES) {
    if (name === value) return name;
  }

  return null;
}

/**
 * Strict decoder for the serialized, already normalized form of a `HookEvent` read
 * back from local state. State on disk is untrusted input: unknown or missing keys,
 * wrong types and inconsistent tool categories are all rejected.
 */
export function decodeHookEvent(value: unknown): HookEvent | HookEventParseFailure {
  if (!isJsonObject(value)) return failed("NOT_AN_OBJECT", "event").failure;

  const name = eventName(value.name);

  if (name === null) return failed("UNKNOWN_EVENT", "name").failure;

  const base = decodeBase(value, name);
  if (!base.ok) return base.failure;

  const decoded = decodeBody(value, name, base.value);

  return decoded.ok ? decoded.value : decoded.failure;
}
