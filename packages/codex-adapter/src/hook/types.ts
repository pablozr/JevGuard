/**
 * What the Codex hook works on: the host's payload reduced to the identity of the turn
 * and the pairing of its calls, with task text, model output, paths and raw tool payloads
 * left behind in the decoder.
 *
 * Nothing here is a verdict. This slice (F1 of ADR 0019) keeps one unit per turn and says
 * whether its lifecycle is complete; the acquisitions that prove a change arrive with the
 * next slice, and until then no unit can be reviewed at all.
 */

/** A host payload the hook understands, reduced to identity and call pairing. */
export type CodexTurnEvent =
  | { readonly kind: "SESSION_START"; readonly sessionId: string }
  | { readonly kind: "TURN_OPEN"; readonly sessionId: string; readonly turnId: string }
  | {
      readonly kind: "TOOL_PRE";
      readonly sessionId: string;
      readonly turnId: string;
      readonly toolUseId: string;
    }
  | {
      readonly kind: "TOOL_POST";
      readonly sessionId: string;
      readonly turnId: string;
      readonly toolUseId: string;
    }
  | { readonly kind: "TURN_CLOSE"; readonly sessionId: string; readonly turnId: string }
  | { readonly kind: "SESSION_END"; readonly sessionId: string };

/**
 * Why a unit's lifecycle cannot be trusted. Each one says the evidence is incomplete,
 * never that something was fine: a tainted unit can only end `UNAVAILABLE`.
 */
export type CodexTaintReason =
  /** A turn event whose opening was never seen: the hook was not running at its start. */
  | "HOOK_NOT_TRUSTED"
  /** A `PostToolUse` with no `PreToolUse`, or a `PreToolUse` that never got its `Post`. */
  | "TOOL_CALL_UNPAIRED"
  /** The same call seen twice on one side. */
  | "TOOL_CALL_DUPLICATED"
  /** A turn that was replaced by another before it closed. */
  | "TURN_NOT_CLOSED"
  /** A payload outside the closed contract, which may be a host that changed. */
  | "UNSUPPORTED_EVENT"
  /** A payload the session's ids could not be read from, so no unit can say what it was. */
  | "PAYLOAD_UNREADABLE"
  /** The local lifecycle file could not be read as this slice wrote it. */
  | "STATE_DAMAGED";

/**
 * Codes the hook may write to its log. Closed on purpose: the log carries the code, the
 * event name and a timestamp, never a task, a path, a tool input or a finding.
 */
export type CodexHookLogCode =
  | "SESSION_START"
  | "TURN_OPENED"
  | "TURN_CLOSED"
  | "UNIT_UNAVAILABLE"
  | "HOOK_NOT_TRUSTED"
  | "TOOL_CALL_UNPAIRED"
  | "TOOL_CALL_DUPLICATED"
  | "TURN_NOT_CLOSED"
  | "UNSUPPORTED_EVENT"
  | "PAYLOAD_UNREADABLE"
  | "STATE_DAMAGED"
  | "PARSE_FAILED"
  | "STDIN_TOO_LARGE"
  | "STATE_READ_FAILED"
  | "STATE_WRITE_FAILED"
  | "INTERNAL";

/** Why a payload could not be decoded; also the suffix of `PARSE_FAILED:<reason>`. */
export type CodexDecodeFailure =
  | "NOT_JSON"
  | "NOT_OBJECT"
  | "MISSING_SESSION_ID"
  | "MISSING_TURN_ID"
  | "MISSING_TOOL_USE_ID"
  | "UNSUPPORTED_EVENT";

/** One line of the session's append-only lifecycle file. */
export type CodexStateLine =
  | { readonly v: 1; readonly kind: "OPEN"; readonly turn: string; readonly at: string }
  | { readonly v: 1; readonly kind: "CALL"; readonly turn: string; readonly call: string }
  | { readonly v: 1; readonly kind: "PAIR"; readonly turn: string; readonly call: string }
  | {
      readonly v: 1;
      readonly kind: "TAINT";
      readonly turn: string;
      readonly reason: CodexTaintReason;
    }
  | { readonly v: 1; readonly kind: "SESSION_TAINT"; readonly reason: CodexTaintReason }
  | { readonly v: 1; readonly kind: "CLOSE"; readonly turn: string; readonly at: string };

/** One call of the open unit, as its pairing stands. */
export interface CodexCallState {
  readonly toolUseId: string;
  readonly paired: boolean;
}

/** One unit (turn) and everything its lifecycle proved so far. */
export interface CodexUnitState {
  readonly turnId: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
  readonly calls: readonly CodexCallState[];
  readonly taints: readonly CodexTaintReason[];
}

/** What the session's lifecycle file replays to. */
export interface CodexSessionState {
  readonly units: readonly CodexUnitState[];
  /** A session-level taint that has no unit yet, absorbed by the next one opened. */
  readonly pendingTaints: readonly CodexTaintReason[];
  /** At least one line could not be read; nothing after it can be trusted. */
  readonly damaged: boolean;
}

/** The lines to append and the codes to log for one event. */
export interface CodexLifecycleStep {
  readonly lines: readonly CodexStateLine[];
  readonly codes: readonly CodexHookLogCode[];
}

/** A hook log entry: codes only, so it can never carry the task, a diff or a finding. */
export interface CodexHookLogEntry {
  readonly v: 1;
  readonly at: string;
  readonly event: string;
  readonly code: string;
}
