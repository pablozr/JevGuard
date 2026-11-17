/**
 * Raw payloads the Codex host sends to a command hook, as observed on
 * `codex-cli 0.162.1` (2026-11-16, see `fixtures/README.md`).
 *
 * These types describe the host's own encoding — snake_case field names, host
 * ids, raw tool arguments — and not JevGuard's normalized turn model. Nothing
 * here reads, validates or normalizes a payload: this slice (F0) only fixes what
 * the host promises, with the captured payloads as the proof.
 *
 * Two fields the host does send are deliberately **not** part of this contract:
 *
 * - `transcript_path`: the host documents the transcript format as unstable, so
 *   it can never be read for evidence, task or closing.
 * - `last_assistant_message` / `prompt` carry user task text and model output.
 *   They are available to a hook, but the review-log contract forbids writing
 *   task, diff or findings anywhere.
 */

/** Events a command hook can be configured for in this slice. */
export type CodexHookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionEnd";

/** Fields every observed payload carries. */
export interface CodexPayloadBase {
  readonly session_id: string;
  readonly cwd: string;
  readonly hook_event_name: CodexHookEventName;
  /** Present on every payload observed except `SessionEnd`. */
  readonly model?: string;
  /** Present on every payload observed except `SessionEnd`. */
  readonly permission_mode?: string;
}

/** `SessionStart` opens a session; `source` is why it started. */
export interface CodexSessionStartPayload extends CodexPayloadBase {
  readonly hook_event_name: "SessionStart";
  /** `startup`, `resume`, `clear`, `compact` or `fork`. */
  readonly source: string;
}

/**
 * `UserPromptSubmit` opens the turn and already carries its `turn_id`, so the
 * unit key is available before any tool call. `prompt` is the task text and
 * must never be logged or sent as evidence.
 */
export interface CodexUserPromptSubmitPayload extends CodexPayloadBase {
  readonly hook_event_name: "UserPromptSubmit";
  readonly turn_id: string;
  readonly prompt: string;
}

/** Fields shared by both halves of a tool call. */
export interface CodexToolCallPayload extends CodexPayloadBase {
  readonly turn_id: string;
  /** `Bash`, `apply_patch` or `mcp__<server>__<tool>` in the observed session. */
  readonly tool_name: string;
  readonly tool_input: Readonly<Record<string, unknown>>;
  /**
   * Identifies the call across its two halves. Observed shape `exec-<uuid>`,
   * the same for shell, patch and MCP calls — not a per-kind id.
   */
  readonly tool_use_id: string;
}

/** `PreToolUse` fires before the call runs, including for calls that end refused. */
export interface CodexPreToolUsePayload extends CodexToolCallPayload {
  readonly hook_event_name: "PreToolUse";
}

/** `PostToolUse` fires after the call produced a result. */
export interface CodexPostToolUsePayload extends CodexToolCallPayload {
  readonly hook_event_name: "PostToolUse";
  /**
   * The call's result in the host's shape: a string for `Bash` and
   * `apply_patch`, an object with `content[]` for an MCP tool.
   */
  readonly tool_response: unknown;
}

/** `apply_patch` always sends the complete patch as the `command` string. */
export interface CodexApplyPatchInput {
  readonly command: string;
}

/** `Stop` closes the turn, and names the same `turn_id` it was opened with. */
export interface CodexStopPayload extends CodexPayloadBase {
  readonly hook_event_name: "Stop";
  readonly turn_id: string;
  readonly stop_hook_active: boolean;
  /** Model output; never logged, never evidence. */
  readonly last_assistant_message: string;
}

/**
 * `SessionEnd` closes the session. It carries no `model`, no `permission_mode`
 * and no `turn_id`, and on this host it is best-effort: it did not arrive in
 * every observed run.
 */
export interface CodexSessionEndPayload extends CodexPayloadBase {
  readonly hook_event_name: "SessionEnd";
  readonly reason: string;
}

/** Any payload a command hook can receive in this slice. */
export type CodexHookPayload =
  | CodexSessionStartPayload
  | CodexUserPromptSubmitPayload
  | CodexPreToolUsePayload
  | CodexPostToolUsePayload
  | CodexStopPayload
  | CodexSessionEndPayload;
