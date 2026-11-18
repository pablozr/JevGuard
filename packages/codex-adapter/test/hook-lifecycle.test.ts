import { describe, expect, test } from "vitest";
import { replayState, stepLifecycle } from "../src/hook";
import type {
  CodexHookLogCode,
  CodexSessionState,
  CodexStateLine,
  CodexTurnEvent,
} from "../src/hook";

/**
 * The lifecycle rules of one unit, decided only by the host's event order. Every case goes
 * back through `replayState`, the same reading the hook gets on its next invocation, so a
 * rule that writes something unreadable fails here.
 */

const AT = new Date("2026-11-17T12:00:00.000Z");

const SESSION = "s-1";
const TURN = "t-1";

const start: CodexTurnEvent = { kind: "SESSION_START", sessionId: SESSION };
const open: CodexTurnEvent = { kind: "TURN_OPEN", sessionId: SESSION, turnId: TURN };
const close: CodexTurnEvent = { kind: "TURN_CLOSE", sessionId: SESSION, turnId: TURN };

function pre(toolUseId: string, turnId = TURN): CodexTurnEvent {
  return { kind: "TOOL_PRE", sessionId: SESSION, turnId, toolUseId };
}

function post(toolUseId: string, turnId = TURN): CodexTurnEvent {
  return { kind: "TOOL_POST", sessionId: SESSION, turnId, toolUseId };
}

function run(events: readonly CodexTurnEvent[]): {
  readonly state: CodexSessionState;
  readonly codes: readonly CodexHookLogCode[];
  readonly lines: readonly CodexStateLine[];
} {
  let state: CodexSessionState = { units: [], pendingTaints: [], damaged: false };
  const codes: CodexHookLogCode[] = [];
  const lines: CodexStateLine[] = [];

  for (const event of events) {
    const step = stepLifecycle(state, event, AT);

    codes.push(...step.codes);
    lines.push(...step.lines);
    state = replayState(lines);
  }

  return { state, codes, lines };
}

function onlyUnit(state: CodexSessionState) {
  const unit = state.units[0];

  if (unit === undefined) throw new Error("the session must have one unit");

  expect(state.units).toHaveLength(1);

  return unit;
}

describe("a turn that the hook sees from its opening", () => {
  test("closes complete, with every call paired", () => {
    const { state, codes } = run([start, open, pre("c-1"), post("c-1"), close]);

    expect(codes).toEqual(["SESSION_START", "TURN_OPENED", "TURN_CLOSED"]);

    const unit = onlyUnit(state);

    expect(unit.turnId).toBe(TURN);
    expect(unit.closedAt).toBe(AT.toISOString());
    expect(unit.taints).toEqual([]);
    expect(unit.calls).toEqual([{ toolUseId: "c-1", paired: true }]);
  });

  test("repeats its opening harmlessly", () => {
    const { state, codes } = run([open, open, close]);

    expect(codes).toEqual(["TURN_OPENED", "TURN_CLOSED"]);
    expect(onlyUnit(state).taints).toEqual([]);
  });

  test("counts each call once when the same call half arrives twice", () => {
    const { state, codes } = run([open, pre("c-1"), pre("c-1"), post("c-1"), close]);

    expect(codes).toContain("TOOL_CALL_DUPLICATED");
    expect(onlyUnit(state).taints).toEqual(["TOOL_CALL_DUPLICATED"]);
  });

  test("calls a second Post a duplicate, not an unpaired half", () => {
    const { state, codes } = run([open, pre("c-1"), post("c-1"), post("c-1"), close]);

    expect(codes).toContain("TOOL_CALL_DUPLICATED");
    expect(codes).not.toContain("TOOL_CALL_UNPAIRED");
    expect(onlyUnit(state).taints).toEqual(["TOOL_CALL_DUPLICATED"]);
  });
});

describe("a turn whose evidence cannot be complete", () => {
  test("a Post with no Pre marks the unit", () => {
    const { state, codes } = run([open, post("c-1"), close]);

    expect(codes).toEqual([
      "TURN_OPENED",
      "TOOL_CALL_UNPAIRED",
      "UNIT_UNAVAILABLE",
      "TOOL_CALL_UNPAIRED",
      "UNIT_UNAVAILABLE",
    ]);
    expect(onlyUnit(state).taints).toEqual(["TOOL_CALL_UNPAIRED"]);
  });

  test("a Pre that never gets its Post marks the unit at Stop", () => {
    const { state, codes } = run([open, pre("c-1"), close]);

    expect(codes).toEqual(["TURN_OPENED", "TOOL_CALL_UNPAIRED", "UNIT_UNAVAILABLE"]);
    expect(onlyUnit(state).taints).toEqual(["TOOL_CALL_UNPAIRED"]);
  });

  test("the refused calls of the captured session mark its unit, never skip it", () => {
    const { state, codes } = run([start, open, pre("c-1"), pre("c-2"), close]);

    expect(codes).toEqual([
      "SESSION_START",
      "TURN_OPENED",
      "TOOL_CALL_UNPAIRED",
      "UNIT_UNAVAILABLE",
    ]);
    expect(onlyUnit(state).taints).toEqual(["TOOL_CALL_UNPAIRED"]);
  });

  test("a Stop with no opening at all says the hook was not trusted at the start", () => {
    const { state, codes } = run([close]);

    expect(codes).toEqual(["HOOK_NOT_TRUSTED", "UNIT_UNAVAILABLE"]);
    expect(onlyUnit(state).taints).toEqual(["HOOK_NOT_TRUSTED"]);
  });

  test("a tool call with no opening marks the turn it arrived in", () => {
    const { state } = run([pre("c-1")]);

    expect(onlyUnit(state).taints).toEqual(["HOOK_NOT_TRUSTED"]);
  });

  test("a turn replaced before its Stop keeps the old one marked and closed", () => {
    const { state, codes } = run([open, { ...open, turnId: "t-2" }]);

    expect(codes).toEqual(["TURN_OPENED", "TURN_OPENED", "TURN_NOT_CLOSED", "UNIT_UNAVAILABLE"]);
    expect(state.units).toHaveLength(2);
    expect(state.units[0]?.taints).toEqual(["TURN_NOT_CLOSED"]);
    expect(state.units[0]?.closedAt).toBe(AT.toISOString());
    expect(state.units[1]?.taints).toEqual([]);
  });

  test("a Stop naming another turn marks both units unavailable", () => {
    const { state, codes } = run([open, { ...close, turnId: "t-2" }]);

    expect(codes).toEqual([
      "TURN_OPENED",
      "TURN_NOT_CLOSED",
      "UNIT_UNAVAILABLE",
      "HOOK_NOT_TRUSTED",
    ]);
    expect(state.units.map((unit) => unit.taints)).toEqual([
      ["TURN_NOT_CLOSED"],
      ["HOOK_NOT_TRUSTED"],
    ]);
  });

  test("a repeated Stop adds nothing", () => {
    const { codes } = run([open, close, close]);

    expect(codes).toEqual(["TURN_OPENED", "TURN_CLOSED"]);
  });
});

describe("a session-level mark", () => {
  test("lands on the next unit, which can only end unavailable", () => {
    let state: CodexSessionState = { units: [], pendingTaints: [], damaged: false };
    const lines: CodexStateLine[] = [{ v: 1, kind: "SESSION_TAINT", reason: "UNSUPPORTED_EVENT" }];

    state = replayState(lines);
    expect(state.pendingTaints).toEqual(["UNSUPPORTED_EVENT"]);

    const step = stepLifecycle(state, open, AT);

    lines.push(...step.lines);
    state = replayState(lines);

    expect(onlyUnit(state).taints).toEqual(["UNSUPPORTED_EVENT"]);

    const closing = stepLifecycle(state, close, AT);

    expect(closing.codes).toEqual(["UNSUPPORTED_EVENT", "UNIT_UNAVAILABLE"]);
  });
});

describe("a damaged lifecycle file", () => {
  test("is replayed as damaged and keeps what could be read", () => {
    const lines: readonly (CodexStateLine | null)[] = [
      { v: 1, kind: "OPEN", turn: TURN, at: AT.toISOString() },
      null,
      { v: 1, kind: "CLOSE", turn: TURN, at: AT.toISOString() },
    ];
    const state = replayState(lines);

    expect(state.damaged).toBe(true);
    expect(onlyUnit(state).closedAt).toBe(AT.toISOString());
  });
});
