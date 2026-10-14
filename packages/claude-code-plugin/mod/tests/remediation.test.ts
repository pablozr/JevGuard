import type { On } from "claude-code";
import { type Engine, expect, mock, test } from "claude-code/testing";

const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const POLL_MS = 2000;
const EPOCH = "0123456789abcdef";
const FEED_FILE = feedFileOf("sess1");
const DELIVERIES_KEY = "jevguard/agentDeliveries";
const PANE_ID = "jevguard-proposal";
const MARKER = "[JevGuard remediation proposal · automatic delivery";
const SYSTEM_TEXT = "SYSTEM_TEXT_8841";
const PROMPT_TEXT = "PROMPT_TEXT_6620";
const SESSION = { cwd: "/project", surface: "terminal", isInteractive: true } as const;
const ZERO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};
const PROPOSAL_TEXT = [
  "Strategy",
  "1. Split the module.",
  "",
  "Why",
  "It resolves the finding.",
  "",
  "Manual apply: split the module in two files",
].join("\n");

function feedFileOf(session: string): string {
  return `/data/jevguard/claude-code/feed/${session}.jsonl`;
}

function turnId(ordinal: number, session = "sess1"): string {
  return `claude-code:${session}:${EPOCH}:${ordinal}`;
}

function requestPath(ordinal: number, session = "sess1"): string {
  return `/data/jevguard/claude-code/proposals/${session}/${EPOCH}-${ordinal}.json`;
}

function requestFile(ordinal: number, overrides: object = {}, session = "sess1"): string {
  return JSON.stringify({
    v: 1,
    kind: "PROPOSAL_REQUEST",
    turnId: turnId(ordinal, session),
    createdAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    delivery: "user",
    model: "sonnet",
    system: SYSTEM_TEXT,
    prompt: PROMPT_TEXT,
    ...overrides,
  });
}

function feedLines(ordinals: readonly number[], session = "sess1"): string {
  const counts = { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 };

  return ordinals
    .flatMap((ordinal) => [
      JSON.stringify({
        v: 1,
        kind: "STARTED",
        turnId: turnId(ordinal, session),
        at: new Date(NOW).toISOString(),
      }),
      JSON.stringify({
        v: 1,
        kind: "RECORDED",
        turnId: turnId(ordinal, session),
        at: new Date(NOW).toISOString(),
        counts,
        causes: [],
        results: [],
        proposal: true,
      }),
    ])
    .join("\n");
}

const BACKSLASH = String.fromCharCode(92);

function posix(path: string): string {
  return path
    .split(BACKSLASH)
    .join("/")
    .replace(/^[A-Za-z]:/, "");
}

function world(on: On) {
  const state = {
    files: new Map<string, string>(),
    reads: [] as string[],
    order: [] as string[],
    writes: [] as { path: string; text: string }[],
    models: [] as { model: string; system?: string; prompt: string }[],
    submits: [] as { text: string; origin: unknown }[],
    opens: [] as { id: string; title?: string }[],
    copies: [] as string[],
    logs: [] as string[],
    toasts: [] as string[],
    placed: true,
    refuse: false,
    sessionId: "sess1",
    failWrite: false,
    values: new Map<string, unknown>(),
    versions: new Map<string, number>(),
    completion: { isAnswered: true, text: PROPOSAL_TEXT, usage: ZERO_USAGE } as object,
  };
  const clock = mock.clock(on, { now: NOW });

  mock.env(on, { XDG_DATA_HOME: "/data" });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("state.get", (_$, e) => {
    const key = `${e.plugin}/${e.key}`;

    return {
      value: { value: state.values.get(key), version: state.versions.get(key) ?? 0 },
    } as never;
  });
  on("state.set", (_$, e) => {
    const key = `${e.plugin}/${e.key}`;
    const version = (state.versions.get(key) ?? 0) + 1;

    state.values.set(key, e.value);
    state.versions.set(key, version);

    return { value: { isSet: true, version } } as never;
  });
  on("session.id", () => ({ value: state.sessionId }));
  on("session.model", () => ({ value: "session-model" }));
  on("fs.read", (_$, e) => {
    state.reads.push(posix(e.path));

    const text = state.files.get(posix(e.path));

    return text === undefined ? { deny: "missing" } : { value: text };
  });
  on("fs.write", (_$, e) => {
    if (state.failWrite) return { deny: "readonly" };

    state.order.push(`write:${posix(e.path)}`);
    state.writes.push({ path: posix(e.path), text: e.text });
    state.files.set(posix(e.path), e.text);

    return { value: undefined };
  });
  on("model.complete", (_$, e) => {
    state.order.push("model");
    state.models.push({ model: e.model, system: e.system, prompt: e.prompt });

    if (state.refuse) return { deny: "refused" };

    return { value: state.completion as never };
  });
  on("prompt.submit", (_$, e) => {
    state.submits.push({ text: e.text, origin: e.origin });

    return { text: e.text };
  });
  on("ui.open", (_$, e) => {
    state.opens.push({ id: e.id, title: e.title });

    return {
      value: state.placed ? { isPlaced: true } : { isPlaced: false, reason: "narrow" },
    } as const;
  });
  on("ui.close", () => ({ value: undefined }));
  on("ui.copy", (_$, e) => {
    state.copies.push(e.text);

    return { value: { isCopied: true } } as const;
  });
  on("ui.log", (_$, e) => {
    state.logs.push(e.text);

    return { value: undefined };
  });
  on("ui.toast", (_$, e) => {
    state.toasts.push(e.text);

    return { value: undefined };
  });
  on("ui.status", () => ({ value: undefined }));

  return { state, clock };
}

type World = ReturnType<typeof world>;

function seed(
  state: World["state"],
  ordinals: readonly number[],
  overrides: object = {},
  session = "sess1",
): void {
  for (const ordinal of ordinals) {
    state.files.set(requestPath(ordinal, session), requestFile(ordinal, overrides, session));
  }
}

async function completeTurn($: Engine): Promise<void> {
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
}

async function settle(clock: World["clock"]): Promise<void> {
  for (let tick = 0; tick < 4; tick += 1) await clock.advance(POLL_MS);
}

test("user mode blanks the request, makes one completion and opens the panel", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1]);
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.order).toEqual([`write:${requestPath(1)}`, "model"]);
  expect(state.writes).toEqual([{ path: requestPath(1), text: "" }]);
  expect(state.models).toEqual([{ model: "sonnet", system: SYSTEM_TEXT, prompt: PROMPT_TEXT }]);
  expect(state.opens).toEqual([{ id: PANE_ID, title: "JevGuard proposal" }]);
  expect(state.toasts).toContain("JevGuard proposal ready · unit 1");
  expect(state.submits).toEqual([]);
});

test("a request without a model uses the main turn's model", async ($, on) => {
  const first = world(on);

  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
    usage: { ...ZERO_USAGE, model: "claude-main" },
  });
  seed(first.state, [1], { model: null });
  first.state.files.set(FEED_FILE, feedLines([1]));
  await settle(first.clock);

  expect(first.state.models.map((call) => call.model)).toEqual(["claude-main"]);
});

test("without a main turn model the session's model is used", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1], { model: null });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.models.map((call) => call.model)).toEqual(["session-model"]);
});

test("agent mode submits one framed message and never as the user", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1], { delivery: "agent" });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.submits).toHaveLength(1);
  expect(state.submits[0]?.text.startsWith(MARKER)).toBe(true);
  expect(JSON.stringify(state.submits[0]?.origin)).not.toContain("asUser");
  expect(state.logs).toContain("JevGuard sent a remediation proposal for unit 1 to the agent");
  expect(state.opens).toHaveLength(1);
});

test("the fourth agent delivery in a session becomes a panel with a limit line", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1, 2, 3, 4], { delivery: "agent" });
  state.files.set(FEED_FILE, feedLines([1, 2, 3, 4]));
  await settle(clock);

  expect(state.submits).toHaveLength(3);
  expect(state.models).toHaveLength(4);
  expect(state.logs).toContain(
    "JevGuard agent delivery limit reached · unit 4 · shown here instead",
  );
  expect(state.toasts).toContain("JevGuard proposal ready · unit 4");
});

test("a request that cannot be blanked never reaches the model", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await completeTurn($);
  seed(state, [1]);
  state.files.set(FEED_FILE, feedLines([1]));
  state.failWrite = true;
  await settle(clock);

  expect(state.models).toEqual([]);
  expect(state.toasts).toContain("JevGuard remediation proposal failed");
  expect(state.logs).toContain("JevGuard proposal unavailable · unit 1 · REQUEST_UNREADABLE");
  expect(JSON.stringify([state.logs, state.toasts])).not.toContain(PROMPT_TEXT);
});

test("the delivery limit survives a reload", async ($, on) => {
  const { state, clock } = world(on);

  state.values.set(DELIVERIES_KEY, { sess1: 3 });
  await $.session.start(SESSION);
  await completeTurn($);
  seed(state, [1], { delivery: "agent" });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.submits).toEqual([]);
  expect(state.logs).toContain(
    "JevGuard agent delivery limit reached · unit 1 · shown here instead",
  );
});

test("each session keeps its own delivery count and returning to one resumes it", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await completeTurn($);
  seed(state, [1, 2], { delivery: "agent" });
  state.files.set(FEED_FILE, feedLines([1, 2]));
  await settle(clock);

  state.sessionId = "sess2";
  await $.session.start(SESSION);
  await completeTurn($);
  seed(state, [1], { delivery: "agent" }, "sess2");
  state.files.set(feedFileOf("sess2"), feedLines([1], "sess2"));
  await settle(clock);

  expect(state.values.get(DELIVERIES_KEY)).toEqual({ sess1: 2, sess2: 1 });
  expect(state.submits).toHaveLength(3);

  state.sessionId = "sess1";
  await $.session.start(SESSION);
  await completeTurn($);
  seed(state, [3, 4], { delivery: "agent" });
  state.files.set(FEED_FILE, feedLines([1, 2, 3, 4]));
  await settle(clock);

  expect(state.submits).toHaveLength(4);
  expect(state.logs).toContain(
    "JevGuard agent delivery limit reached · unit 4 · shown here instead",
  );
});

test("switching sessions without a session start never replays the old feed", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  state.sessionId = "sess2";
  seed(state, [1], {}, "sess2");
  state.files.set(feedFileOf("sess2"), feedLines([1], "sess2"));
  await completeTurn($);
  await settle(clock);

  expect(state.models).toEqual([]);
  expect(state.logs).toEqual([]);
  expect(state.toasts).toEqual([]);
  expect(state.reads).not.toContain(requestPath(1, "sess2"));
});

test("a blank request is skipped without a model call or a failure", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  state.files.set(requestPath(1), "");
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.models).toEqual([]);
  expect(state.toasts).not.toContain("JevGuard remediation proposal failed");
});

test("an expired or invalid request fails generically and never reaches the model", async ($, on) => {
  const { state, clock } = world(on);

  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1], { expiresAt: new Date(NOW - 1).toISOString() });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  const visible = JSON.stringify([state.logs, state.toasts]);

  expect(state.models).toEqual([]);
  expect(state.toasts).toContain("JevGuard remediation proposal failed");
  expect(state.logs).toContain("JevGuard proposal unavailable · unit 1 · REQUEST_INVALID");
  expect(visible).not.toContain(PROMPT_TEXT);
  expect(visible).not.toContain("/data/");
});

test("an API error is one typed failure and is never retried", async ($, on) => {
  const { state, clock } = world(on);

  state.completion = {
    isAnswered: false,
    reason: "api-error",
    status: 429,
    error: "rate_limit",
    usage: ZERO_USAGE,
  };
  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1]);
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.models).toHaveLength(1);
  expect(state.logs).toContain("JevGuard proposal unavailable · unit 1 · MODEL_API_ERROR");
  expect(state.opens).toEqual([]);
});

test("a refused completion is contained as MODEL_REFUSED", async ($, on) => {
  const { state, clock } = world(on);

  state.refuse = true;
  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1]);
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.models).toHaveLength(1);
  expect(state.logs).toContain("JevGuard proposal unavailable · unit 1 · MODEL_REFUSED");
});

test("a panel that is not placed falls back to log lines of at most 1900 characters", async ($, on) => {
  const { state, clock } = world(on);
  const long = "x".repeat(4000);

  state.placed = false;
  state.completion = { isAnswered: true, text: long, usage: ZERO_USAGE };
  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  seed(state, [1]);
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  const chunks = state.logs.filter((text) => text.startsWith("x"));

  expect(chunks.map((text) => text.length)).toEqual([1900, 1900, 200]);
  expect(chunks.join("")).toBe(long);
});

test("a proposal already in the feed at session start is never replayed", async ($, on) => {
  const { state, clock } = world(on);

  seed(state, [1]);
  state.files.set(FEED_FILE, feedLines([1]));
  await $.session.start(SESSION);
  await $.turn.complete({
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "t1",
    reason: "answer",
  });
  await settle(clock);

  expect(state.models).toEqual([]);
  expect(state.reads).not.toContain(requestPath(1));
  expect(state.writes).toEqual([]);
});

for (const surface of ["terminal", "desktop"] as const) {
  test(`the panel draws the proposal and copies the apply instruction on ${surface}`, async ($, on) => {
    const { state, clock } = world(on);

    await $.session.start(SESSION);
    await $.turn.complete({
      answer: "",
      durationMs: 1,
      isAborted: false,
      turnId: "t1",
      reason: "answer",
    });
    seed(state, [1]);
    state.files.set(FEED_FILE, feedLines([1]));
    await settle(clock);

    const ui = await $.ui.mount({
      plugin: "jevguard",
      surface,
      component: "Pane",
      requestId: PANE_ID,
      props: {
        title: "JevGuard proposal",
        isFocused: false,
        bodyColumns: 80,
        placement: "inline",
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    });
    const markdown = await ui.find({ type: "Markdown", key: "proposal" });

    expect(markdown?.props.text).toBe(PROPOSAL_TEXT);

    await ui.press({ key: "copy" });

    expect(state.copies).toEqual(["split the module in two files"]);
  });
}
