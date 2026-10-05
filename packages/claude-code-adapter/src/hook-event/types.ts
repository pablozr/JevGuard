export type ToolCategory =
  | "EDIT"
  | "BASH"
  | "POWERSHELL"
  | "MCP"
  | "AGENT"
  | "READONLY"
  | "COORDINATION"
  | "UNKNOWN";

/**
 * Reading of `tool_response.bashEditDiff` for a Bash call. `ABSENT` means the host
 * reported no Git-visible change; `INCOMPLETE` covers any incompleteness flag, an
 * unidentified entry, or an unknown shape.
 */
export type ShellEditDiff =
  | { readonly status: "ABSENT" }
  | { readonly status: "PRESENT"; readonly changedFiles: readonly string[] }
  | { readonly status: "INCOMPLETE" };

/** `UNKNOWN` covers an absent or unreadable `background_tasks`. */
export type BackgroundTasksState = "EMPTY" | "ACTIVE" | "UNKNOWN";

export interface HookEventBase {
  readonly sessionId: string;
  readonly cwd: string;
  readonly promptId: string | null;
  readonly agentId: string | null;
}

export interface ToolCall {
  readonly toolName: string;
  readonly category: ToolCategory;
  readonly toolUseId: string;
  readonly filePath: string | null;
  readonly runInBackground: boolean;
}

export interface SessionStartEvent extends HookEventBase {
  readonly name: "SessionStart";
}

export interface SessionEndEvent extends HookEventBase {
  readonly name: "SessionEnd";
}

export interface SubagentStartEvent extends HookEventBase {
  readonly name: "SubagentStart";
}

export interface SubagentStopEvent extends HookEventBase {
  readonly name: "SubagentStop";
}

/** `prompt` is `null` when the host did not provide the prompt as text. */
export interface UserPromptSubmitEvent extends HookEventBase {
  readonly name: "UserPromptSubmit";
  readonly prompt: string | null;
}

export interface PreToolUseEvent extends HookEventBase {
  readonly name: "PreToolUse";
  readonly tool: ToolCall;
}

export interface PostToolUseEvent extends HookEventBase {
  readonly name: "PostToolUse";
  readonly tool: ToolCall;
  readonly shellDiff: ShellEditDiff;
}

export interface PostToolUseFailureEvent extends HookEventBase {
  readonly name: "PostToolUseFailure";
  readonly tool: ToolCall;
}

export interface StopEvent extends HookEventBase {
  readonly name: "Stop";
  readonly backgroundTasks: BackgroundTasksState;
  readonly stopHookActive: boolean;
}

export interface StopFailureEvent extends HookEventBase {
  readonly name: "StopFailure";
}

export type HookEvent =
  | SessionStartEvent
  | SessionEndEvent
  | SubagentStartEvent
  | SubagentStopEvent
  | UserPromptSubmitEvent
  | PreToolUseEvent
  | PostToolUseEvent
  | PostToolUseFailureEvent
  | StopEvent
  | StopFailureEvent;

export type HookEventName = HookEvent["name"];

export type HookEventParseReason =
  | "NOT_AN_OBJECT"
  | "UNKNOWN_EVENT"
  | "MISSING_FIELD"
  | "INVALID_FIELD";

/** Carries the offending field name only, never a payload value. */
export interface HookEventParseFailure {
  readonly invalid: true;
  readonly reason: HookEventParseReason;
  readonly field: string;
}

export type JsonObject = Readonly<Record<string, unknown>>;
