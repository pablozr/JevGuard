import {
  DEFAULT_EVIDENCE_POLICY,
  type JevEvaluationPort,
  type JevEvaluationResult,
  type JevRequest,
  type ReviewResult,
} from "@jevguard/core";
import {
  createOpenCodeLogSink,
  createOpenCodeToastSink,
  createReviewPresenter,
  InMemoryTurnDeduplicator,
  type OpenCodeFileDiff,
  type OpenCodeLogInput,
  type OpenCodeLogResult,
  type OpenCodeMessageRecord,
  type OpenCodePresentationClient,
  type OpenCodeSessionFacade,
  type OpenCodeToastInput,
  type OpenCodeToastResult,
  type PolicyLoader,
  type PolicyLoadResult,
  type PresentationDelivery,
  type ReviewPresenter,
} from "@jevguard/opencode-adapter";
import type { Plugin } from "@opencode-ai/plugin";
import { describe, expect, test } from "vitest";
import { JevGuardPlugin } from "../src/index";
import { createPluginRuntime } from "../src/runtime";
import type { PluginHooks, PluginRuntimeDependencies } from "../src/types";

const SESSION_ID = "ses_1";
const ASSISTANT_ID = "msg_assistant";
const USER_ID = "msg_user";

const VALID_RULE = [
  "## TEST-1",
  "",
  "severity: error",
  "",
  "### Rule",
  "",
  "Module description.",
  "",
  "### Violation",
  "",
  "The change violates the rule.",
].join("\n");

const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

const ALLOWED_EXCEPTION = "Read-only validation and HTTP mapping are allowed.";
const DOCS_SENTINEL = "DOCS_SENTINEL_PATCH";
const GLOBAL_SENTINEL = "GLOBAL_SENTINEL_PATCH";
const HIDDEN_REASONING_SENTINEL = "HIDDEN_REASONING_SENTINEL";

function scopedRule(severity: "error" | "warning"): string {
  return [
    "## TEST-1",
    "",
    `severity: ${severity}`,
    "scope: src/**",
    "",
    "### Rule",
    "",
    "Module description.",
    "",
    "### Violation",
    "",
    "The change violates the rule.",
    "",
    "### Allowed",
    "",
    ALLOWED_EXCEPTION,
  ].join("\n");
}

function idleEvent(sessionID: string = SESSION_ID): unknown {
  return { type: "session.status", properties: { sessionID, status: { type: "idle" } } };
}

function turnRecords(): readonly OpenCodeMessageRecord[] {
  return [
    {
      info: { id: USER_ID, role: "user" },
      parts: [{ type: "text", text: "Implement the thing." }],
    },
    {
      info: {
        id: ASSISTANT_ID,
        role: "assistant",
        parentID: USER_ID,
        time: { created: 1, completed: 2 },
      },
      parts: [],
    },
  ];
}

function patchDiffs(): readonly OpenCodeFileDiff[] {
  return [{ file: "src/a.ts", patch: PATCH }];
}

function distractorRecords(): readonly OpenCodeMessageRecord[] {
  return [
    {
      info: { id: "msg_user_prior", role: "user" },
      parts: [{ type: "text", text: "Prior distractor task." }],
    },
    {
      info: {
        id: "msg_assistant_prior",
        role: "assistant",
        parentID: "msg_user_prior",
        time: { created: 1, completed: 2 },
      },
      parts: [],
    },
    {
      info: { id: USER_ID, role: "user" },
      parts: [
        { type: "text", text: "Add the guard." },
        { type: "reasoning", text: HIDDEN_REASONING_SENTINEL },
        { type: "tool" },
        { type: "text", text: "Keep it scoped." },
      ],
    },
    {
      info: {
        id: ASSISTANT_ID,
        role: "assistant",
        parentID: USER_ID,
        time: { created: 3, completed: 4 },
      },
      parts: [],
    },
  ];
}

function mixedDiffs(): readonly OpenCodeFileDiff[] {
  return [
    { file: "src/a.ts", patch: PATCH },
    { file: "docs/readme.md", patch: DOCS_SENTINEL },
    { file: "outside.txt", patch: GLOBAL_SENTINEL },
  ];
}

interface MessageQuery {
  readonly sessionID: string;
}

interface DiffQuery {
  readonly sessionID: string;
  readonly messageID: string;
}

class FakeFacade implements OpenCodeSessionFacade {
  readonly calls: string[] = [];
  readonly messageQueries: MessageQuery[] = [];
  readonly diffQueries: DiffQuery[] = [];
  readonly forbidden: string[] = [];
  records: readonly OpenCodeMessageRecord[] = turnRecords();
  diffs: readonly OpenCodeFileDiff[] = patchDiffs();
  failure: "none" | "messages" | "diff" = "none";

  async listMessages(input: MessageQuery): Promise<readonly OpenCodeMessageRecord[]> {
    this.calls.push("listMessages");
    this.messageQueries.push({ sessionID: input.sessionID });

    if (this.failure === "messages") {
      throw new Error("messages unavailable");
    }

    return this.records;
  }

  async fetchDiff(input: DiffQuery): Promise<readonly OpenCodeFileDiff[]> {
    this.calls.push("fetchDiff");
    this.diffQueries.push({ sessionID: input.sessionID, messageID: input.messageID });

    if (this.failure === "diff") {
      throw new Error("diff unavailable");
    }

    return this.diffs;
  }

  prompt(): void {
    this.forbidden.push("prompt");
  }

  updateMessage(): void {
    this.forbidden.push("updateMessage");
  }

  transformChatMessages(): void {
    this.forbidden.push("transformChatMessages");
  }
}

class FakePolicyLoader implements PolicyLoader {
  readonly calls: string[] = [];
  result: PolicyLoadResult = { status: "LOADED", source: { rules: VALID_RULE, config: null } };
  failure: Error | null = null;

  async load(): Promise<PolicyLoadResult> {
    this.calls.push("load");

    if (this.failure !== null) {
      throw this.failure;
    }

    return this.result;
  }
}

class FakePresenter implements ReviewPresenter {
  readonly results: ReviewResult[] = [];
  attempts = 0;
  fail = false;

  async present(result: ReviewResult): Promise<PresentationDelivery> {
    this.attempts += 1;

    if (this.fail) {
      throw new Error("presentation unavailable");
    }

    this.results.push(result);

    return { log: "DELIVERED", toast: "DELIVERED" };
  }
}

class FakeJev implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];
  probability = 0.1;
  fail = false;

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    if (this.fail) {
      return { status: "FAILED", reason: "MISSING_CREDENTIAL" };
    }

    return { status: "EVALUATED", noul: { violationProbability: this.probability } };
  }
}

class FakePresentationClient implements OpenCodePresentationClient {
  readonly logCalls: OpenCodeLogInput[] = [];
  readonly toastCalls: OpenCodeToastInput[] = [];

  readonly app = {
    log: (input: OpenCodeLogInput): Promise<OpenCodeLogResult> => {
      this.logCalls.push(input);

      return Promise.resolve({});
    },
  };

  readonly tui = {
    showToast: (input: OpenCodeToastInput): Promise<OpenCodeToastResult> => {
      this.toastCalls.push(input);

      return Promise.resolve({});
    },
  };
}

interface Harness {
  readonly hooks: PluginHooks;
  readonly facade: FakeFacade;
  readonly policy: FakePolicyLoader;
  readonly presenter: FakePresenter;
  readonly jev: FakeJev;
}

function harness(): Harness {
  const facade = new FakeFacade();
  const policy = new FakePolicyLoader();
  const presenter = new FakePresenter();
  const jev = new FakeJev();

  const dependencies: PluginRuntimeDependencies = {
    facade,
    deduplicator: new InMemoryTurnDeduplicator(),
    policy,
    presenter,
    jev,
  };

  return { hooks: createPluginRuntime(dependencies), facade, policy, presenter, jev };
}

interface PresentationHarness {
  readonly hooks: PluginHooks;
  readonly facade: FakeFacade;
  readonly policy: FakePolicyLoader;
  readonly jev: FakeJev;
  readonly client: FakePresentationClient;
}

function presentationHarness(rules: string = VALID_RULE): PresentationHarness {
  const facade = new FakeFacade();
  const policy = new FakePolicyLoader();
  policy.result = { status: "LOADED", source: { rules, config: null } };
  const jev = new FakeJev();
  const client = new FakePresentationClient();
  const presenter = createReviewPresenter({
    log: createOpenCodeLogSink(client),
    toast: createOpenCodeToastSink(client),
  });

  const dependencies: PluginRuntimeDependencies = {
    facade,
    deduplicator: new InMemoryTurnDeduplicator(),
    policy,
    presenter,
    jev,
  };

  return { hooks: createPluginRuntime(dependencies), facade, policy, jev, client };
}

async function dispatch(hooks: PluginHooks, event: unknown): Promise<void> {
  await hooks.event({ event });
}

describe("JevGuardPlugin composition", () => {
  test("root entrypoint exports a typed OpenCode Plugin", () => {
    const plugin: Plugin = JevGuardPlugin;

    expect(typeof plugin).toBe("function");
  });

  test("ignores events that are not an idle session status", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();

    await dispatch(hooks, { type: "session.idle", properties: { sessionID: SESSION_ID } });
    await dispatch(hooks, {
      type: "session.status",
      properties: { sessionID: SESSION_ID, status: { type: "busy" } },
    });
    await dispatch(hooks, { type: "message.updated", properties: {} });

    expect(facade.calls).toEqual([]);
    expect(policy.calls).toEqual([]);
    expect(presenter.attempts).toBe(0);
    expect(jev.requests).toHaveLength(0);
  });

  test.each([
    { probability: 0.1, outcome: "PASS" },
    { probability: 0.5, outcome: "WARN" },
    { probability: 0.8, outcome: "FAIL" },
  ])(
    "presents one $outcome review for probability $probability",
    async ({ probability, outcome }) => {
      const { hooks, facade, policy, presenter, jev } = harness();
      jev.probability = probability;

      await dispatch(hooks, idleEvent());

      expect(facade.calls).toEqual(["listMessages", "fetchDiff"]);
      expect(policy.calls).toEqual(["load"]);
      expect(jev.requests).toHaveLength(1);
      expect(presenter.results).toEqual([
        {
          turnId: ASSISTANT_ID,
          ruleId: "TEST-1",
          severity: "error",
          scopedPaths: ["src/a.ts"],
          outcome,
          violationProbability: probability,
        },
      ]);
    },
  );

  test("skips a turn with no attributed patch without calling Jev", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.diffs = [];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_ATTRIBUTED_PATCH",
      },
    ]);
  });

  test("never invokes message mutation or prompt APIs", async () => {
    const { hooks, facade } = harness();

    await dispatch(hooks, idleEvent());

    expect(facade.forbidden).toEqual([]);
  });
});

describe("JevGuardPlugin operational failures", () => {
  test("reports MISSING_ATTRIBUTED_DIFF when the messages read fails", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    facade.failure = "messages";

    await dispatch(hooks, idleEvent());

    expect(policy.calls).toEqual([]);
    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: SESSION_ID,
        ruleId: null,
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "MISSING_ATTRIBUTED_DIFF",
      },
    ]);
  });

  test("reports MISSING_ATTRIBUTED_DIFF when the diff read fails", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.failure = "diff";

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: SESSION_ID,
        ruleId: null,
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "MISSING_ATTRIBUTED_DIFF",
      },
    ]);
  });

  test("reports INVALID_RULE when the rules file is absent", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: null, config: null } };

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: null,
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_RULE",
      },
    ]);
  });

  test("reports INVALID_RULE when the rules read fails", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "FAILED", reason: "RULES_READ_FAILURE" };

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: null,
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_RULE",
      },
    ]);
  });

  test("reports INVALID_RULE when the rule parser rejects the document", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: "not a rule document", config: null } };

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: null,
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_RULE",
      },
    ]);
  });

  test("reports INVALID_CONFIG when the config YAML is malformed", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: VALID_RULE, config: "a: [unclosed" } };

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_CONFIG",
      },
    ]);
  });

  test("reports INVALID_CONFIG when the config shape does not resolve", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const config = [
      "version: 2",
      "thresholds:",
      "  error:",
      "    warn: 0.1",
      "    fail: 0.5",
      "  warning:",
      "    warn: 0.5",
    ].join("\n");
    policy.result = { status: "LOADED", source: { rules: VALID_RULE, config } };

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_CONFIG",
      },
    ]);
  });

  test("reports INVALID_CONFIG when the config read fails", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "FAILED", reason: "CONFIG_READ_FAILURE" };

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: null,
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_CONFIG",
      },
    ]);
  });

  test("reports JEV_FAILURE when the Jev port fails", async () => {
    const { hooks, presenter, jev } = harness();
    jev.fail = true;

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(1);
    expect(presenter.results).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: ["src/a.ts"],
        outcome: "UNAVAILABLE",
        reason: "JEV_FAILURE",
      },
    ]);
  });
});

describe("JevGuardPlugin deduplication and containment", () => {
  test("evaluates a repeated idle only once", async () => {
    const { hooks, presenter, jev } = harness();

    await dispatch(hooks, idleEvent());
    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(1);
    expect(presenter.results).toHaveLength(1);
  });

  test("evaluates concurrent idle events only once", async () => {
    const { hooks, presenter, jev } = harness();

    await Promise.all([dispatch(hooks, idleEvent()), dispatch(hooks, idleEvent())]);

    expect(jev.requests).toHaveLength(1);
    expect(presenter.results).toHaveLength(1);
  });

  test("contains a presentation failure without retry or replacement result", async () => {
    const { hooks, presenter, jev } = harness();
    presenter.fail = true;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jev.requests).toHaveLength(1);
    expect(presenter.attempts).toBe(1);
    expect(presenter.results).toEqual([]);
  });

  test("swallows an unknown failure without mislabeling a result", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.failure = new Error("programming bug");

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jev.requests).toHaveLength(0);
    expect(presenter.attempts).toBe(0);
    expect(presenter.results).toEqual([]);
  });

  test("keeps handling later idle events after a contained failure", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.failure = "messages";

    await dispatch(hooks, idleEvent());
    expect(jev.requests).toHaveLength(0);
    expect(presenter.results).toHaveLength(1);

    facade.failure = "none";
    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(1);
    expect(presenter.results).toHaveLength(2);
    expect(presenter.results[1]?.outcome).toBe("PASS");
  });
});

describe("JevGuardPlugin end-to-end flow", () => {
  test("delivers one scoped review from idle through Jev to log and toast", async () => {
    const { hooks, facade, jev, client } = presentationHarness(scopedRule("error"));
    facade.records = distractorRecords();
    facade.diffs = mixedDiffs();
    jev.probability = 0.5;

    await dispatch(hooks, idleEvent());

    expect(facade.messageQueries).toEqual([{ sessionID: SESSION_ID }]);
    expect(facade.diffQueries).toEqual([{ sessionID: SESSION_ID, messageID: USER_ID }]);
    expect(facade.forbidden).toEqual([]);

    expect(jev.requests).toHaveLength(1);

    const request = jev.requests[0];

    if (request === undefined) {
      throw new Error("expected exactly one Jev request");
    }

    expect(request.question.type).toBe("noul");
    expect(request.question.criteria).toEqual({
      id: "TEST-1",
      description: "Module description.",
      violation: "The change violates the rule.",
      allowed: ALLOWED_EXCEPTION,
    });
    expect(JSON.stringify(request).split(ALLOWED_EXCEPTION)).toHaveLength(2);
    expect(request.task).toBe("Add the guard.\nKeep it scoped.");
    expect(request.change).toEqual({ files: ["src/a.ts"], diff: PATCH });
    expect(JSON.stringify(request)).not.toContain(DOCS_SENTINEL);
    expect(JSON.stringify(request)).not.toContain(GLOBAL_SENTINEL);
    expect(JSON.stringify(request)).not.toContain(HIDDEN_REASONING_SENTINEL);

    expect(client.logCalls).toHaveLength(1);
    expect(client.toastCalls).toHaveLength(1);
    expect(client.logCalls[0]?.body).toEqual({
      service: "jevguard",
      level: "warn",
      message: "JevGuard WARN for TEST-1 (probability 0.5)",
      extra: {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: ["src/a.ts"],
        outcome: "WARN",
        violationProbability: 0.5,
      },
    });
    expect(client.toastCalls[0]?.body).toEqual({
      title: "JevGuard WARN",
      message: "TEST-1 · probability 0.50",
      variant: "warning",
      duration: 5000,
    });
  });

  test("deduplicates repeated idle events to one Jev call and one presentation", async () => {
    const { hooks, jev, client } = presentationHarness(scopedRule("error"));

    await dispatch(hooks, idleEvent());
    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(1);
    expect(client.logCalls).toHaveLength(1);
    expect(client.toastCalls).toHaveLength(1);
  });

  test("deduplicates concurrent idle events to one Jev call and one presentation", async () => {
    const { hooks, jev, client } = presentationHarness(scopedRule("error"));

    await Promise.all([dispatch(hooks, idleEvent()), dispatch(hooks, idleEvent())]);

    expect(jev.requests).toHaveLength(1);
    expect(client.logCalls).toHaveLength(1);
    expect(client.toastCalls).toHaveLength(1);
  });
});

describe("JevGuardPlugin gate propagation", () => {
  test.each([
    { severity: "error", probability: 0.399, outcome: "PASS", level: "info", variant: "success" },
    { severity: "error", probability: 0.4, outcome: "WARN", level: "warn", variant: "warning" },
    { severity: "error", probability: 0.699, outcome: "WARN", level: "warn", variant: "warning" },
    { severity: "error", probability: 0.7, outcome: "FAIL", level: "error", variant: "error" },
    { severity: "warning", probability: 0.599, outcome: "PASS", level: "info", variant: "success" },
    { severity: "warning", probability: 0.6, outcome: "WARN", level: "warn", variant: "warning" },
    { severity: "warning", probability: 1, outcome: "WARN", level: "warn", variant: "warning" },
  ] as const)(
    "propagates $severity probability $probability as $outcome to log and toast",
    async ({ severity, probability, outcome, level, variant }) => {
      const { hooks, jev, client } = presentationHarness(scopedRule(severity));
      jev.probability = probability;

      await dispatch(hooks, idleEvent());

      expect(jev.requests).toHaveLength(1);
      expect(client.logCalls).toHaveLength(1);
      expect(client.logCalls[0]?.body.level).toBe(level);
      expect(client.logCalls[0]?.body.message).toBe(
        `JevGuard ${outcome} for TEST-1 (probability ${probability})`,
      );
      expect(client.logCalls[0]?.body.extra).toEqual({
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity,
        scopedPaths: ["src/a.ts"],
        outcome,
        violationProbability: probability,
      });
      expect(client.toastCalls[0]?.body).toEqual({
        title: `JevGuard ${outcome}`,
        message: `TEST-1 · probability ${probability.toFixed(2)}`,
        variant,
        duration: 5000,
      });
    },
  );
});

describe("JevGuardPlugin runtime short-circuits", () => {
  test("skips an out-of-scope turn without a Jev call or probability", async () => {
    const { hooks, facade, jev, client } = presentationHarness(scopedRule("error"));
    facade.diffs = [{ file: "docs/readme.md", patch: DOCS_SENTINEL }];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(client.logCalls[0]?.body).toEqual({
      service: "jevguard",
      level: "info",
      message: "JevGuard SKIPPED for TEST-1 (NO_SCOPE_MATCH)",
      extra: {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_SCOPE_MATCH",
      },
    });
    expect(client.logCalls[0]?.body.extra).not.toHaveProperty("violationProbability");
    expect(client.toastCalls[0]?.body).toEqual({
      title: "JevGuard SKIPPED",
      message: "TEST-1 · NO_SCOPE_MATCH",
      variant: "info",
      duration: 5000,
    });
  });

  test("reports an oversized scoped patch as UNAVAILABLE without a Jev call", async () => {
    const { hooks, facade, jev, client } = presentationHarness(scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1) },
    ];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(client.logCalls[0]?.body).toEqual({
      service: "jevguard",
      level: "error",
      message: "JevGuard UNAVAILABLE for TEST-1 (OVERSIZED_DIFF)",
      extra: {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "OVERSIZED_DIFF",
      },
    });
    expect(client.logCalls[0]?.body.extra).not.toHaveProperty("violationProbability");
    expect(client.toastCalls[0]?.body).toEqual({
      title: "JevGuard UNAVAILABLE",
      message: "TEST-1 · OVERSIZED_DIFF",
      variant: "error",
      duration: 5000,
    });
  });

  test("reports a blocked applicable file as UNAVAILABLE without a Jev call", async () => {
    const { hooks, facade, jev, client } = presentationHarness(scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "src/.env", patch: "SECRET=1" },
    ];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(client.logCalls[0]?.body).toEqual({
      service: "jevguard",
      level: "error",
      message: "JevGuard UNAVAILABLE for TEST-1 (BLOCKED_EVIDENCE)",
      extra: {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "BLOCKED_EVIDENCE",
      },
    });
    expect(client.logCalls[0]?.body.extra).not.toHaveProperty("violationProbability");
    expect(client.toastCalls[0]?.body).toEqual({
      title: "JevGuard UNAVAILABLE",
      message: "TEST-1 · BLOCKED_EVIDENCE",
      variant: "error",
      duration: 5000,
    });
  });
});

describe("JevGuardPlugin observe-only containment", () => {
  test("resolves the FAIL flow without mutating agent messages", async () => {
    const { hooks, facade, jev, client } = presentationHarness(scopedRule("error"));
    facade.records = distractorRecords();
    facade.diffs = mixedDiffs();
    jev.probability = 0.8;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(client.logCalls[0]?.body.extra).toMatchObject({
      outcome: "FAIL",
      violationProbability: 0.8,
    });
    expect(client.toastCalls[0]?.body.variant).toBe("error");
    expect(facade.forbidden).toEqual([]);
  });

  test("resolves the UNAVAILABLE flow without mutating agent messages", async () => {
    const { hooks, facade, jev, client } = presentationHarness(scopedRule("error"));
    jev.fail = true;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jev.requests).toHaveLength(1);
    expect(client.logCalls[0]?.body.extra).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(client.logCalls[0]?.body.extra).not.toHaveProperty("violationProbability");
    expect(facade.forbidden).toEqual([]);
  });
});
