import {
  DEFAULT_EVIDENCE_POLICY,
  type JevEvaluationPort,
  type JevEvaluationResult,
  type JevRequest,
  type RuleReviewResult,
  type TurnReview,
} from "@jevguard/core";
import {
  InMemoryTurnDeduplicator,
  type OpenCodeFileDiff,
  type OpenCodeMessageRecord,
  type OpenCodeSessionFacade,
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

const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

const ALLOWED_EXCEPTION = "Read-only validation and HTTP mapping are allowed.";
const DOCS_SENTINEL = "DOCS_SENTINEL_PATCH";
const GLOBAL_SENTINEL = "GLOBAL_SENTINEL_PATCH";
const HIDDEN_REASONING_SENTINEL = "HIDDEN_REASONING_SENTINEL";

function ruleText(id: string, severity: "error" | "warning", scope: string | null): string {
  const lines = [`## ${id}`, "", `severity: ${severity}`];

  if (scope !== null) {
    lines.push(`scope: ${scope}`);
  }

  lines.push(
    "",
    "### Rule",
    "",
    "Module description.",
    "",
    "### Violation",
    "",
    "The change violates the rule.",
  );

  return lines.join("\n");
}

function missingSeverityRule(id: string): string {
  return [
    `## ${id}`,
    "",
    "### Rule",
    "",
    "Module description.",
    "",
    "### Violation",
    "",
    "The change violates the rule.",
  ].join("\n");
}

const VALID_RULE = ruleText("TEST-1", "error", null);

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
  readonly reviews: TurnReview[] = [];
  attempts = 0;
  fail = false;

  async present(review: TurnReview): Promise<PresentationDelivery> {
    this.attempts += 1;

    if (this.fail) {
      throw new Error("presentation unavailable");
    }

    this.reviews.push(review);

    return { log: "DELIVERED", toast: "DELIVERED" };
  }
}

class FakeJev implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];
  probability = 0.1;
  fail = false;
  readonly failingRuleIds = new Set<string>();

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    if (this.fail || this.failingRuleIds.has(request.question.criteria.id)) {
      return { status: "FAILED", reason: "MISSING_CREDENTIAL" };
    }

    return { status: "EVALUATED", noul: { violationProbability: this.probability } };
  }
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

async function dispatch(hooks: PluginHooks, event: unknown): Promise<void> {
  await hooks.event({ event });
}

function lastReview(presenter: FakePresenter): TurnReview {
  const review = presenter.reviews[presenter.reviews.length - 1];

  if (review === undefined) {
    throw new Error("expected a presented review");
  }

  return review;
}

function lastResults(presenter: FakePresenter): readonly RuleReviewResult[] {
  return lastReview(presenter).results;
}

function jevRuleIds(jev: FakeJev): readonly string[] {
  return jev.requests.map((request) => request.question.criteria.id);
}

function loadRules(policy: FakePolicyLoader, rules: string, config: string | null = null): void {
  policy.result = { status: "LOADED", source: { rules, config } };
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
    "presents one $outcome aggregate review for probability $probability",
    async ({ probability, outcome }) => {
      const { hooks, facade, policy, presenter, jev } = harness();
      jev.probability = probability;

      await dispatch(hooks, idleEvent());

      expect(facade.calls).toEqual(["listMessages", "fetchDiff"]);
      expect(policy.calls).toEqual(["load"]);
      expect(jev.requests).toHaveLength(1);
      expect(presenter.reviews).toHaveLength(1);
      expect(lastResults(presenter)).toEqual([
        {
          turnId: ASSISTANT_ID,
          ruleId: "TEST-1",
          severity: "error",
          scopedPaths: ["src/a.ts"],
          outcome,
          violationProbability: probability,
        },
      ]);
      expect(lastReview(presenter).summary.verdict).toBe(outcome);
    },
  );

  test("skips a turn with no attributed patch without calling Jev", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.diffs = [];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_ATTRIBUTED_PATCH",
      },
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: null,
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 1, unavailable: 0 },
    });
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
    expect(lastResults(presenter)).toEqual([
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
  test("evaluates a repeated idle only once and presents one aggregate", async () => {
    const { hooks, presenter, jev } = harness();

    await dispatch(hooks, idleEvent());
    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(1);
    expect(presenter.reviews).toHaveLength(1);
  });

  test("evaluates concurrent idle events only once", async () => {
    const { hooks, presenter, jev } = harness();

    await Promise.all([dispatch(hooks, idleEvent()), dispatch(hooks, idleEvent())]);

    expect(jev.requests).toHaveLength(1);
    expect(presenter.reviews).toHaveLength(1);
  });

  test("contains a presentation failure without retry or replacement review", async () => {
    const { hooks, presenter, jev } = harness();
    presenter.fail = true;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jev.requests).toHaveLength(1);
    expect(presenter.attempts).toBe(1);
    expect(presenter.reviews).toEqual([]);
  });

  test("swallows an unknown failure without mislabeling a review", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.failure = new Error("programming bug");

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jev.requests).toHaveLength(0);
    expect(presenter.attempts).toBe(0);
    expect(presenter.reviews).toEqual([]);
  });

  test("keeps handling later idle events after a contained failure", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.failure = "messages";

    await dispatch(hooks, idleEvent());
    expect(jev.requests).toHaveLength(0);
    expect(presenter.reviews).toHaveLength(1);

    facade.failure = "none";
    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(1);
    expect(presenter.reviews).toHaveLength(2);
    expect(lastResults(presenter)[0]?.outcome).toBe("PASS");
  });
});

describe("JevGuardPlugin multi-rule end-to-end", () => {
  test("calls Jev only for applicable rules and presents one aggregate in source order", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    const rules = [
      ruleText("SRC-1", "error", "src/**"),
      ruleText("TEST-2", "warning", "tests/**"),
      ruleText("GLOBAL-3", "warning", null),
    ].join("\n\n");
    loadRules(policy, rules);
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "docs/readme.md", patch: DOCS_SENTINEL },
    ];

    await dispatch(hooks, idleEvent());

    expect(presenter.reviews).toHaveLength(1);
    expect(jevRuleIds(jev)).toEqual(["SRC-1", "GLOBAL-3"]);
    expect(lastResults(presenter).map((result) => result.ruleId)).toEqual([
      "SRC-1",
      "TEST-2",
      "GLOBAL-3",
    ]);
    expect(lastResults(presenter).map((result) => result.outcome)).toEqual([
      "PASS",
      "SKIPPED",
      "PASS",
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: false,
      counts: { pass: 2, warn: 0, fail: 0, skipped: 1, unavailable: 0 },
    });
  });

  test("evaluates valid siblings when one rule block is malformed", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const rules = [
      ruleText("GOOD-1", "error", "src/**"),
      missingSeverityRule("BAD-2"),
      ruleText("GOOD-3", "warning", "src/**"),
    ].join("\n\n");
    loadRules(policy, rules);

    await dispatch(hooks, idleEvent());

    expect(jevRuleIds(jev)).toEqual(["GOOD-1", "GOOD-3"]);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "GOOD-1",
        severity: "error",
        scopedPaths: ["src/a.ts"],
        outcome: "PASS",
        violationProbability: 0.1,
      },
      {
        turnId: ASSISTANT_ID,
        ruleId: "BAD-2",
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_RULE",
      },
      {
        turnId: ASSISTANT_ID,
        ruleId: "GOOD-3",
        severity: "warning",
        scopedPaths: ["src/a.ts"],
        outcome: "PASS",
        violationProbability: 0.1,
      },
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: true,
      counts: { pass: 2, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
    });
  });

  test("records duplicate rule IDs as invalid without calling Jev", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const rules = [ruleText("DUP-1", "error", "src/**"), ruleText("DUP-1", "error", "src/**")].join(
      "\n\n",
    );
    loadRules(policy, rules);

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(presenter.reviews).toHaveLength(1);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "DUP-1",
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_RULE",
      },
      {
        turnId: ASSISTANT_ID,
        ruleId: "DUP-1",
        severity: null,
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_RULE",
      },
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: null,
      hasUnavailable: true,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 2 },
    });
  });

  test("does not suppress later rules after a single Jev failure", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const rules = [ruleText("FAIL-1", "error", "src/**"), ruleText("OK-2", "error", "src/**")].join(
      "\n\n",
    );
    loadRules(policy, rules);
    jev.failingRuleIds.add("FAIL-1");

    await dispatch(hooks, idleEvent());

    expect(jevRuleIds(jev)).toEqual(["FAIL-1", "OK-2"]);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "FAIL-1",
        severity: "error",
        scopedPaths: ["src/a.ts"],
        outcome: "UNAVAILABLE",
        reason: "JEV_FAILURE",
      },
      {
        turnId: ASSISTANT_ID,
        ruleId: "OK-2",
        severity: "error",
        scopedPaths: ["src/a.ts"],
        outcome: "PASS",
        violationProbability: 0.1,
      },
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: true,
      counts: { pass: 1, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
    });
  });

  test("keeps blocked, oversized, and clean rule evidence independent and disjoint", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    const rules = [
      ruleText("BLOCK-1", "error", "src/**"),
      ruleText("BIG-2", "error", "big/**"),
      ruleText("CLEAN-3", "warning", "clean/**"),
    ].join("\n\n");
    loadRules(policy, rules);
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "src/.env", patch: "SECRET=1" },
      { file: "big/data.ts", patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1) },
      { file: "clean/a.ts", patch: PATCH },
    ];

    await dispatch(hooks, idleEvent());

    expect(jevRuleIds(jev)).toEqual(["CLEAN-3"]);
    expect(lastResults(presenter).map((result) => result.outcome)).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
      "PASS",
    ]);
    expect(lastResults(presenter)[0]).toMatchObject({
      ruleId: "BLOCK-1",
      outcome: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
    expect(lastResults(presenter)[1]).toMatchObject({
      ruleId: "BIG-2",
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: true,
      counts: { pass: 1, warn: 0, fail: 0, skipped: 0, unavailable: 2 },
    });
  });

  test("reports the invalid config once per rule and evaluates none", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const rules = [ruleText("A-1", "error", "src/**"), ruleText("B-2", "warning", null)].join(
      "\n\n",
    );
    const config = [
      "version: 2",
      "thresholds:",
      "  error:",
      "    warn: 0.1",
      "    fail: 0.5",
      "  warning:",
      "    warn: 0.5",
    ].join("\n");
    loadRules(policy, rules, config);

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "A-1",
        severity: "error",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_CONFIG",
      },
      {
        turnId: ASSISTANT_ID,
        ruleId: "B-2",
        severity: "warning",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "INVALID_CONFIG",
      },
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: null,
      hasUnavailable: true,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 2 },
    });
  });

  test("deduplicates repeated idles to one Jev call per applicable rule and one aggregate", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    const rules = [
      ruleText("SRC-1", "error", "src/**"),
      ruleText("GLOBAL-2", "warning", null),
    ].join("\n\n");
    loadRules(policy, rules);
    facade.diffs = [{ file: "src/a.ts", patch: PATCH }];

    await dispatch(hooks, idleEvent());
    await dispatch(hooks, idleEvent());

    expect(jevRuleIds(jev)).toEqual(["SRC-1", "GLOBAL-2"]);
    expect(presenter.reviews).toHaveLength(1);
  });
});

describe("JevGuardPlugin gate propagation", () => {
  test.each([
    { severity: "error", probability: 0.399, outcome: "PASS" },
    { severity: "error", probability: 0.4, outcome: "WARN" },
    { severity: "error", probability: 0.699, outcome: "WARN" },
    { severity: "error", probability: 0.7, outcome: "FAIL" },
    { severity: "warning", probability: 0.599, outcome: "PASS" },
    { severity: "warning", probability: 0.6, outcome: "WARN" },
    { severity: "warning", probability: 1, outcome: "WARN" },
  ] as const)(
    "propagates $severity probability $probability as $outcome into the aggregate",
    async ({ severity, probability, outcome }) => {
      const { hooks, policy, presenter, jev } = harness();
      loadRules(policy, scopedRule(severity));
      jev.probability = probability;

      await dispatch(hooks, idleEvent());

      expect(jev.requests).toHaveLength(1);
      expect(lastResults(presenter)).toEqual([
        {
          turnId: ASSISTANT_ID,
          ruleId: "TEST-1",
          severity,
          scopedPaths: ["src/a.ts"],
          outcome,
          violationProbability: probability,
        },
      ]);
      expect(lastReview(presenter).summary.verdict).toBe(outcome);
    },
  );
});

describe("JevGuardPlugin runtime short-circuits", () => {
  test("skips an out-of-scope turn without a Jev call", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [{ file: "docs/readme.md", patch: DOCS_SENTINEL }];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_SCOPE_MATCH",
      },
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: null,
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 1, unavailable: 0 },
    });
  });

  test("reports an oversized scoped patch as UNAVAILABLE without a Jev call", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1) },
    ];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "OVERSIZED_DIFF",
      },
    ]);
  });

  test("reports a blocked applicable file as UNAVAILABLE without a Jev call", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "src/.env", patch: "SECRET=1" },
    ];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      {
        turnId: ASSISTANT_ID,
        ruleId: "TEST-1",
        severity: "error",
        scopedPaths: [],
        outcome: "UNAVAILABLE",
        reason: "BLOCKED_EVIDENCE",
      },
    ]);
  });
});

describe("JevGuardPlugin observe-only containment", () => {
  test("resolves the FAIL flow without mutating agent messages", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.records = distractorRecords();
    facade.diffs = mixedDiffs();
    jev.probability = 0.8;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(lastResults(presenter)[0]).toMatchObject({
      outcome: "FAIL",
      violationProbability: 0.8,
    });
    expect(lastReview(presenter).summary.verdict).toBe("FAIL");
    expect(facade.forbidden).toEqual([]);
  });

  test("resolves the UNAVAILABLE flow without mutating agent messages", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    jev.fail = true;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jev.requests).toHaveLength(1);
    expect(lastResults(presenter)[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(facade.forbidden).toEqual([]);
  });
});
