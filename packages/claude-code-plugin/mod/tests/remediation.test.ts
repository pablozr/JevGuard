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
    failSubmit: false,
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
    if (state.failSubmit) throw new Error("submit refused");

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

const CHAIN_ID = turnId(1);

function chainOf(attempt: number, maxAttempts = 2): object {
  return {
    chainId: CHAIN_ID,
    attempt,
    maxAttempts,
    findings: [
      {
        id: "no-eval",
        severity: "error",
        probability: 0.93,
        paths: ["src/a.ts"],
        violation: "Calls eval.",
        allowed: "Never.",
      },
    ],
  };
}

function chainFeedLine(ordinal: number, result: string, attempt: number, fixed = 0): string {
  return JSON.stringify({
    v: 1,
    kind: "RECORDED",
    turnId: turnId(ordinal),
    at: new Date(NOW).toISOString(),
    counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
    causes: [],
    results: [],
    chain: { chainId: CHAIN_ID, attempt, maxAttempts: 2, result, fixed },
  });
}

async function started($: Engine): Promise<void> {
  await $.session.start(SESSION);
  await completeTurn($);
}

test("a remediate request frames the delivery with the attempt n/m and the findings", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  seed(state, [1], { delivery: "agent", chain: chainOf(1) });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  const [submit] = state.submits;

  expect(state.submits).toHaveLength(1);
  expect(submit?.text.startsWith(MARKER)).toBe(true);
  expect(submit?.text).toContain("attempt 1/2");
  expect(submit?.text).toContain("no-eval");
  expect(JSON.stringify(submit?.origin)).not.toContain("asUser");
  expect(state.logs).toContain("JevGuard sent remediation attempt 1/2 for unit 1 to the agent");
  expect(state.toasts).toContain("JevGuard sent remediation attempt 1/2 for unit 1 to the agent");
});

test("the second attempt says 2/2", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  seed(state, [1], { delivery: "agent", chain: chainOf(2) });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.submits[0]?.text).toContain("attempt 2/2");
});

test("a resolved chain is a visible line and toast without a model call or a submit", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  state.files.set(FEED_FILE, chainFeedLine(2, "RESOLVED", 1, 2));
  await settle(clock);

  const line = "JevGuard remediation resolved · unit 2 · 2 finding(s) fixed in 1 attempt(s)";

  expect(state.logs).toContain(line);
  expect(state.toasts).toContain(line);
  expect(state.submits).toEqual([]);
  expect(state.models).toEqual([]);
});

test("a stopped chain is a visible line and toast with its code and no submit", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  state.files.set(FEED_FILE, chainFeedLine(2, "REPEATED_FAILURE", 1));
  await settle(clock);

  const line = "JevGuard remediation stopped · unit 2 · attempt 1/2 · REPEATED_FAILURE";

  expect(state.logs).toContain(line);
  expect(state.toasts).toContain(line);
  expect(state.submits).toEqual([]);
});

test("a chain delivery in flight prints nothing from the feed", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  state.files.set(FEED_FILE, chainFeedLine(2, "DELIVERING", 1));
  await settle(clock);

  expect(state.logs.filter((line) => line.includes("remediation"))).toEqual([]);
});

test("the fourth chain delivery stops with SESSION_LIMIT and shows the proposal", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  seed(state, [1, 2, 3, 4], { delivery: "agent", chain: chainOf(1) });
  state.files.set(FEED_FILE, feedLines([1, 2, 3, 4]));
  await settle(clock);

  const line = "JevGuard remediation stopped · unit 4 · attempt 1/2 · SESSION_LIMIT";

  expect(state.submits).toHaveLength(3);
  expect(state.logs).toContain(line);
  expect(state.toasts).toContain(line);
  expect(state.toasts).toContain("JevGuard proposal ready · unit 4");
});

test("a refused submit is a visible DELIVERY_FAILED and the proposal goes to the user", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  state.failSubmit = true;
  seed(state, [1], { delivery: "agent", chain: chainOf(1) });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  const line = "JevGuard remediation stopped · unit 1 · attempt 1/2 · DELIVERY_FAILED";

  expect(state.submits).toEqual([]);
  expect(state.logs).toContain(line);
  expect(state.toasts).toContain(line);
  expect(state.toasts).toContain("JevGuard proposal ready · unit 1");
});

test("a chain on a user-delivery request is invalid and never reaches the model", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  seed(state, [1], { delivery: "user", chain: chainOf(1) });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.models).toEqual([]);
  expect(state.submits).toEqual([]);
});

function outcomePath(ordinal: number): string {
  return requestPath(ordinal).replace(/\.json$/, ".outcome.json");
}

function outcomeOf(ordinal: number, code: string): string {
  return JSON.stringify({ v: 1, kind: "PROPOSAL_OUTCOME", turnId: turnId(ordinal), code });
}

test("a refused submit in a chain writes a DELIVERY_FAILED outcome for the worker", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  state.failSubmit = true;
  seed(state, [1], { delivery: "agent", chain: chainOf(1) });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.files.get(outcomePath(1))).toBe(outcomeOf(1, "DELIVERY_FAILED"));
});

test("the session limit in a chain writes a SESSION_LIMIT outcome for the fourth unit only", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  seed(state, [1, 2, 3, 4], { delivery: "agent", chain: chainOf(1) });
  state.files.set(FEED_FILE, feedLines([1, 2, 3, 4]));
  await settle(clock);

  expect(state.files.get(outcomePath(4))).toBe(outcomeOf(4, "SESSION_LIMIT"));
  expect([1, 2, 3].map((ordinal) => state.files.get(outcomePath(ordinal)))).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
});

test("a delivered chain request writes no outcome", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  seed(state, [1], { delivery: "agent", chain: chainOf(1) });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.submits).toHaveLength(1);
  expect(state.files.has(outcomePath(1))).toBe(false);
});

test("a failed request without a chain writes no outcome", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  state.failSubmit = true;
  seed(state, [1], { delivery: "agent" });
  state.files.set(FEED_FILE, feedLines([1]));
  await settle(clock);

  expect(state.files.has(outcomePath(1))).toBe(false);
});

test("an invalid remediation config in the feed is a visible line and toast", async ($, on) => {
  const { state, clock } = world(on);

  await started($);
  state.files.set(
    FEED_FILE,
    JSON.stringify({
      v: 1,
      kind: "RECORDED",
      turnId: turnId(2),
      at: new Date(NOW).toISOString(),
      counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
      causes: [],
      results: [],
      remediationConfig: "USER_CONFIG_INVALID",
    }),
  );
  await settle(clock);

  const line =
    "JevGuard remediation is off · your claude-code.yaml is not valid (USER_CONFIG_INVALID) · see docs/configuration.md";

  expect(state.logs).toContain(line);
  expect(state.toasts).toContain(line);
});
