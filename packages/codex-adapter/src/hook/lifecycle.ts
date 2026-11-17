import type {
  CodexCallState,
  CodexHookLogCode,
  CodexLifecycleStep,
  CodexSessionState,
  CodexStateLine,
  CodexTaintReason,
  CodexTurnEvent,
  CodexUnitState,
} from "./types";

/**
 * The unit's lifecycle, as a pure function of the replayed session state and one event.
 *
 * The rules are the ones the F0 capture proved (see `fixtures/README.md` and ADR 0019):
 * `UserPromptSubmit` opens the turn and `Stop` closes it with the same `turn_id`, and
 * every call is seen twice, once per half. Anything that departs from that — an opening
 * the hook did not see, a `Post` with no `Pre`, a `Pre` that never got its `Post`, a turn
 * that moved on without closing — marks the unit, because from that point its evidence
 * cannot be complete. A marked unit may only end `UNAVAILABLE`.
 *
 * A unit opened by a tool call rather than by `UserPromptSubmit` is allowed on purpose:
 * the host may start running hooks mid-turn (right after a user trusts them), and a
 * marked unit is more honest than losing the turn.
 */

function isOpen(unit: CodexUnitState): boolean {
  return unit.closedAt === null;
}

function lastUnit(state: CodexSessionState): CodexUnitState | null {
  return state.units.at(-1) ?? null;
}

/** The unit with this turn id, wherever it sits in the session. */
function unitOf(state: CodexSessionState, turnId: string): CodexUnitState | null {
  for (let index = state.units.length - 1; index >= 0; index -= 1) {
    const unit = state.units[index];

    if (unit?.turnId === turnId) return unit;
  }

  return null;
}

function openedUnit(
  turnId: string,
  at: string,
  taints: readonly CodexTaintReason[],
): CodexUnitState {
  return { turnId, openedAt: at, closedAt: null, calls: [], taints: [...new Set(taints)] };
}

function taintLine(turnId: string, reason: CodexTaintReason): CodexStateLine {
  return { v: 1, kind: "TAINT", turn: turnId, reason };
}

function closeLine(turnId: string, at: string): CodexStateLine {
  return { v: 1, kind: "CLOSE", turn: turnId, at };
}

/** The unit an event is about, opened first if the hook is seeing this turn for the first time. */
interface Resolved {
  readonly state: CodexSessionState;
  readonly unit: CodexUnitState;
  readonly lines: readonly CodexStateLine[];
  readonly codes: readonly CodexHookLogCode[];
}

function resolveStep(
  state: CodexSessionState,
  turnId: string,
  at: string,
  namesItsOpening: boolean,
): Resolved {
  const last = lastUnit(state);
  const lines: CodexStateLine[] = [];
  const codes: CodexHookLogCode[] = [];

  if (last !== null && isOpen(last) && last.turnId === turnId) {
    return { state, unit: last, lines, codes };
  }

  let units = state.units;
  let taints: readonly CodexTaintReason[] = state.pendingTaints;

  if (last !== null && isOpen(last)) {
    // The turn moved on without its `Stop`: that unit can never be complete.
    const closedTaints: readonly CodexTaintReason[] = [
      ...new Set([...last.taints, "TURN_NOT_CLOSED" as const]),
    ];

    units = [...units.slice(0, -1), { ...last, closedAt: at, taints: closedTaints }];
    lines.push(taintLine(last.turnId, "TURN_NOT_CLOSED"), closeLine(last.turnId, at));
    codes.push("TURN_NOT_CLOSED", "UNIT_UNAVAILABLE");

    if (!namesItsOpening) taints = [...taints, "HOOK_NOT_TRUSTED"];
  } else if (!namesItsOpening) {
    taints = [...taints, "HOOK_NOT_TRUSTED"];
  }

  const unit = openedUnit(turnId, at, taints);

  lines.push({ v: 1, kind: "OPEN", turn: turnId, at });

  for (const reason of unit.taints) lines.push(taintLine(turnId, reason));

  codes.push(...unit.taints);

  return {
    state: { units: [...units, unit], pendingTaints: [], damaged: state.damaged },
    unit,
    lines,
    codes,
  };
}

function unique(codes: readonly CodexHookLogCode[]): readonly CodexHookLogCode[] {
  return [...new Set(codes)];
}

function unavailableCodes(taints: readonly CodexTaintReason[]): readonly CodexHookLogCode[] {
  return unique([...taints, "UNIT_UNAVAILABLE"]);
}

function openStep(state: CodexSessionState, turnId: string, at: string): CodexLifecycleStep {
  const last = lastUnit(state);

  if (last !== null && isOpen(last) && last.turnId === turnId) {
    // The host repeated the opening: it says nothing new about the unit.
    return { lines: [], codes: [] };
  }

  const resolved = resolveStep(state, turnId, at, true);

  return { lines: resolved.lines, codes: unique(["TURN_OPENED", ...resolved.codes]) };
}

function callStep(
  state: CodexSessionState,
  event: { readonly turnId: string; readonly toolUseId: string },
  at: string,
  opening: boolean,
): CodexLifecycleStep {
  const resolved = resolveStep(state, event.turnId, at, false);
  const existing = resolved.unit.calls.find((call) => call.toolUseId === event.toolUseId);
  const lines: CodexStateLine[] = [...resolved.lines];
  const codes: CodexHookLogCode[] = [...resolved.codes];

  let unit = resolved.unit;

  if (opening && existing === undefined) {
    const call: CodexCallState = { toolUseId: event.toolUseId, paired: false };

    unit = { ...unit, calls: [...unit.calls, call] };
    lines.push({ v: 1, kind: "CALL", turn: unit.turnId, call: call.toolUseId });
  } else if (opening || existing === undefined || existing.paired) {
    const reason: CodexTaintReason = opening ? "TOOL_CALL_DUPLICATED" : "TOOL_CALL_UNPAIRED";

    unit = { ...unit, taints: [...unit.taints, reason] };
    lines.push(taintLine(unit.turnId, reason));
    codes.push(reason, "UNIT_UNAVAILABLE");
  } else {
    unit = {
      ...unit,
      calls: unit.calls.map((call) =>
        call.toolUseId === event.toolUseId ? { ...call, paired: true } : call,
      ),
    };
    lines.push({ v: 1, kind: "PAIR", turn: unit.turnId, call: event.toolUseId });
  }

  return { lines, codes: unique(codes) };
}

function closeStep(state: CodexSessionState, turnId: string, at: string): CodexLifecycleStep {
  const existing = unitOf(state, turnId);

  // A second `Stop` for a unit already closed says nothing new about it.
  if (existing !== null && !isOpen(existing)) return { lines: [], codes: [] };

  const resolved = resolveStep(state, turnId, at, false);
  const lines: CodexStateLine[] = [...resolved.lines];
  let unit = resolved.unit;

  for (const call of unit.calls) {
    if (call.paired) continue;

    unit = { ...unit, taints: [...new Set([...unit.taints, "TOOL_CALL_UNPAIRED" as const])] };
    lines.push(taintLine(unit.turnId, "TOOL_CALL_UNPAIRED"));
  }

  lines.push(closeLine(turnId, at));

  const outcome: readonly CodexHookLogCode[] =
    unit.taints.length === 0 ? ["TURN_CLOSED"] : unavailableCodes(unit.taints);

  return { lines, codes: unique([...resolved.codes, ...outcome]) };
}

/**
 * What one event does to the session's units: the lines to append and the codes to log.
 * It never throws, never reads the clock and never decides anything but completeness.
 */
export function stepLifecycle(
  state: CodexSessionState,
  event: CodexTurnEvent,
  now: Date,
): CodexLifecycleStep {
  const at = now.toISOString();

  switch (event.kind) {
    case "SESSION_START":
      return { lines: [], codes: ["SESSION_START"] };
    case "SESSION_END":
      return { lines: [], codes: [] };
    case "TURN_OPEN":
      return openStep(state, event.turnId, at);
    case "TOOL_PRE":
      return callStep(state, event, at, true);
    case "TOOL_POST":
      return callStep(state, event, at, false);
    case "TURN_CLOSE":
      return closeStep(state, event.turnId, at);
  }
}

/** The session-level mark for a payload the hook could not read; the next unit absorbs it. */
export function sessionTaintLine(reason: CodexTaintReason): CodexStateLine {
  return { v: 1, kind: "SESSION_TAINT", reason };
}
