import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const POLL_MS = 2000;
const WATCH_WINDOW_MS = 45_000;
const BACKSLASH = String.fromCharCode(92);

const COMPLETE = {
  answer: "",
  durationMs: 1,
  isAborted: false,
  turnId: "t1",
  reason: "answer",
} as const;

const NO_COUNTS = { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 };

function line(
  kind: "STARTED" | "RECORDED",
  ordinal: number,
  body: object = {},
  session = "sess1",
): string {
  return JSON.stringify({
    v: 1,
    kind,
    turnId: `claude-code:${session}:e:${ordinal}`,
    at: new Date(NOW).toISOString(),
    ...body,
  });
}

function recorded(ordinal: number, counts: Partial<typeof NO_COUNTS>, results: object[]): string {
  return line("RECORDED", ordinal, { counts: { ...NO_COUNTS, ...counts }, causes: [], results });
}

const FAIL_RESULT = {
  lane: "RULE",
  id: "ARCH-001",
  sliceCount: null,
  outcome: "FAIL",
  probability: 0.91,
};

const SKIPPED_RESULT = {
  lane: "REVIEW",
  id: null,
  sliceCount: null,
  outcome: "SKIPPED",
  reason: "NO_ATTRIBUTED_PATCH",
};

function world(on: On) {
  const state = {
    sessionId: "sess1",
    feed: "",
    reads: 0,
    denyRead: false,
    logs: [] as string[],
    toasts: [] as string[],
    statuses: [] as (string | undefined)[],
  };
  const clock = mock.clock(on, { now: NOW });

  mock.env(on, { XDG_DATA_HOME: "/data" });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("session.id", () => ({ value: state.sessionId }));
  on("fs.read", () => {
    state.reads += 1;

    return state.denyRead ? { deny: "unreadable" } : { value: state.feed };
  });
  on("ui.log", (_$, e) => {
    state.logs.push(e.text);

    return { value: undefined };
  });
  on("ui.toast", (_$, e) => {
    state.toasts.push(e.text);

    return { value: undefined };
  });
  on("ui.status", (_$, e) => {
    state.statuses.push(e.text);

    return { value: undefined };
  });

  return { state, clock };
}

const SESSION = { cwd: "/project", surface: "terminal", isInteractive: true } as const;

test("a FAIL becomes one transcript line, one toast and the status", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);

  state.feed = `${line("STARTED", 1)}\n${recorded(1, { fail: 1, pass: 2 }, [FAIL_RESULT])}\n`;
  await clock.advance(POLL_MS);
  await clock.advance(POLL_MS);

  expect(state.logs).toEqual(["JevGuard FAIL · unit 1 · fail: ARCH-001 91% · pass 2"]);
  expect(state.toasts).toEqual(["JevGuard FAIL · unit 1 · ARCH-001"]);
  expect(state.statuses.at(-1)).toBe("JevGuard FAIL · unit 1 · 1 fail, 2 pass");
});

test("the status says reviewing first and then shows the result", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);

  state.feed = `${line("STARTED", 1)}\n`;
  await clock.advance(POLL_MS);

  expect(state.statuses.at(-1)).toBe("JevGuard reviewing unit 1...");

  state.feed += `${recorded(1, { pass: 1 }, [])}\n`;
  await clock.advance(POLL_MS);

  expect(state.statuses.at(-1)).toBe("JevGuard PASS · unit 1 · 1 pass");
  expect(state.logs).toHaveLength(1);
});

test("a SKIPPED review only touches the status", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);

  state.feed = `${recorded(1, { skipped: 1 }, [SKIPPED_RESULT])}\n`;
  await clock.advance(POLL_MS);

  expect(state.logs).toEqual([]);
  expect(state.toasts).toEqual([]);
  expect(state.statuses.at(-1)).toBe("JevGuard SKIPPED · unit 1 · no attributed changes");
});

test("a review already in the feed at session start is not shown again", async ($, on) => {
  const { state, clock } = world(on);

  state.feed = `${recorded(1, { fail: 1 }, [FAIL_RESULT])}\n`;
  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);
  await clock.advance(POLL_MS);
  await clock.advance(POLL_MS);

  expect(state.logs).toEqual([]);
  expect(state.toasts).toEqual([]);
});

test("a subagent turn never reads the feed", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);

  const readsAtStart = state.reads;

  await $.turn.complete({ ...COMPLETE, agentId: "agent-1" });
  await clock.advance(POLL_MS * 3);

  expect(state.reads).toBe(readsAtStart);
});

test("an unreadable feed shows nothing and raises nothing", async ($, on) => {
  const { state, clock } = world(on);

  state.denyRead = true;
  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);
  await clock.advance(POLL_MS);
  await clock.advance(POLL_MS);

  expect(state.logs).toEqual([]);
  expect(state.toasts).toEqual([]);
  expect(state.statuses).toEqual([]);
});

test("polling stops once the watch window has passed", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);
  await clock.advance(WATCH_WINDOW_MS + 4000);

  const readsAfterWindow = state.reads;

  await clock.advance(30_000);

  expect(readsAfterWindow).toBeGreaterThan(0);
  expect(state.reads).toBe(readsAfterWindow);
});

test("nothing shown carries a path", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);

  state.feed = [
    line("STARTED", 1),
    recorded(1, { fail: 1, unavailable: 1 }, [
      FAIL_RESULT,
      {
        lane: "BUILT_IN",
        id: "COMPLEXITY",
        sliceCount: null,
        outcome: "UNAVAILABLE",
        reason: "JEV_FAILURE",
      },
    ]),
  ].join("\n");
  await clock.advance(POLL_MS);
  await clock.advance(POLL_MS);

  const shown = [...state.logs, ...state.toasts, ...state.statuses.map((text) => text ?? "")];

  expect(shown.length).toBeGreaterThan(0);

  for (const text of shown) {
    expect(text.includes("/")).toBe(false);
    expect(text.includes(BACKSLASH)).toBe(false);
  }
});

test("a new session while polling never shows the previous session's reviews", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);

  state.sessionId = "sess2";
  await $.session.start(SESSION);

  state.feed = `${recorded(1, { fail: 1 }, [FAIL_RESULT])}\n`;
  await clock.advance(POLL_MS);
  await clock.advance(POLL_MS);

  expect(state.logs).toEqual([]);
  expect(state.toasts).toEqual([]);
});

test("a feed line with an unsafe rule id is never shown", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete(COMPLETE);

  const escapeCharacter = String.fromCharCode(27);

  state.feed = [
    recorded(1, { fail: 1 }, [{ ...FAIL_RESULT, id: "../etc/x" }]),
    recorded(2, { fail: 1 }, [{ ...FAIL_RESULT, id: `ARCH${escapeCharacter}[31m` }]),
  ].join("\n");
  await clock.advance(POLL_MS);
  await clock.advance(POLL_MS);

  expect(state.logs).toEqual([]);
  expect(state.toasts).toEqual([]);
});
