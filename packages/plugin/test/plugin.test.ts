import {
  DEFAULT_EVIDENCE_POLICY,
  type BuiltInReviewResult,
  type BuiltInUnavailableReason,
  createFifoJevPort,
  type JevEvaluationPort,
  type JevEvaluationResult,
  type JevRequest,
  type ReviewLevelResult,
  type ReviewResult,
  type RuleReviewResult,
  type SemanticVerdict,
  type SkippedReason,
  type TurnReview,
  type UnavailableReason,
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
const SCOPE_CREEP_ID = "SCOPE-CREEP";
const COMPLEXITY_ID = "COMPLEXITY";
const MAX_CONCURRENT_JEV_CALLS = 2;

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
  readonly activations: string[] = [];
  readonly probabilities = new Map<string, number>();
  readonly failingIds = new Set<string>();
  active = 0;
  maxActive = 0;
  probability = 0.1;
  fail = false;
  block = false;
  private pending: Array<{ id: string; resolve: () => void }> = [];
  private readonly activationWaiters: Array<{ count: number; resolve: () => void }> = [];

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    const id = request.question.criteria.id;

    this.requests.push(request);
    this.activations.push(id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.notifyActivations();

    if (this.block) {
      await new Promise<void>((resolve) => this.pending.push({ id, resolve }));
    }

    this.active -= 1;

    if (this.fail || this.failingIds.has(id)) {
      return { status: "FAILED", reason: "MISSING_CREDENTIAL" };
    }

    return {
      status: "EVALUATED",
      noul: { violationProbability: this.probabilities.get(id) ?? this.probability },
    };
  }

  async waitForActivations(count: number): Promise<void> {
    if (this.activations.length >= count) {
      return;
    }

    await new Promise<void>((resolve) => this.activationWaiters.push({ count, resolve }));
  }

  release(id?: string): void {
    const remaining: Array<{ id: string; resolve: () => void }> = [];

    for (const entry of this.pending) {
      if (id === undefined || entry.id === id) {
        entry.resolve();
      } else {
        remaining.push(entry);
      }
    }

    this.pending = remaining;
  }

  private notifyActivations(): void {
    this.settle(this.activationWaiters, this.activations.length);
  }

  private settle(waiters: Array<{ count: number; resolve: () => void }>, value: number): void {
    const remaining: Array<{ count: number; resolve: () => void }> = [];

    for (const waiter of waiters) {
      if (value >= waiter.count) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }

    waiters.length = 0;
    waiters.push(...remaining);
  }
}

interface Harness {
  readonly hooks: PluginHooks;
  readonly facade: FakeFacade;
  readonly policy: FakePolicyLoader;
  readonly presenter: FakePresenter;
  readonly jev: FakeJev;
}

/**
 * Mirrors the composition root: the plugin wraps the concrete Jev port in one
 * shared FIFO concurrency limit, so orchestration tests exercise the real cap.
 */
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
    jev: createFifoJevPort(jev, { maxConcurrency: MAX_CONCURRENT_JEV_CALLS }),
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

function lastResults(presenter: FakePresenter): readonly ReviewResult[] {
  return lastReview(presenter).results;
}

function jevIds(jev: FakeJev): readonly string[] {
  return jev.requests.map((request) => request.question.criteria.id);
}

function jevIdSet(jev: FakeJev): ReadonlySet<string> {
  return new Set(jevIds(jev));
}

function loadRules(policy: FakePolicyLoader, rules: string, config: string | null = null): void {
  policy.result = { status: "LOADED", source: { rules, config } };
}

function ruleEvaluated(
  ruleId: string,
  severity: "error" | "warning",
  outcome: SemanticVerdict,
  probability: number,
  scopedPaths: readonly string[],
): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: ASSISTANT_ID,
    ruleId,
    severity,
    scopedPaths,
    outcome,
    violationProbability: probability,
  };
}

function ruleSkipped(
  ruleId: string,
  severity: "error" | "warning" | null,
  reason: SkippedReason,
  scopedPaths: readonly string[] = [],
): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: ASSISTANT_ID,
    ruleId,
    severity,
    scopedPaths,
    outcome: "SKIPPED",
    reason,
  };
}

function ruleUnavailable(
  ruleId: string | null,
  severity: "error" | "warning" | null,
  reason: UnavailableReason,
  scopedPaths: readonly string[] = [],
): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: ASSISTANT_ID,
    ruleId,
    severity,
    scopedPaths,
    outcome: "UNAVAILABLE",
    reason,
  };
}

function builtInEvaluated(
  outcome: SemanticVerdict,
  probability: number,
  scopedPaths: readonly string[],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: SCOPE_CREEP_ID,
    severity: "error",
    scopedPaths,
    outcome,
    violationProbability: probability,
  };
}

function builtInSkipped(): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: SCOPE_CREEP_ID,
    severity: "error",
    scopedPaths: [],
    outcome: "SKIPPED",
    reason: "NO_ATTRIBUTED_PATCH",
  };
}

function builtInUnavailable(
  reason: BuiltInUnavailableReason,
  scopedPaths: readonly string[] = [],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: SCOPE_CREEP_ID,
    severity: "error",
    scopedPaths,
    outcome: "UNAVAILABLE",
    reason,
  };
}

function complexityEvaluated(
  outcome: SemanticVerdict,
  probability: number,
  scopedPaths: readonly string[],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: COMPLEXITY_ID,
    severity: "warning",
    scopedPaths,
    outcome,
    violationProbability: probability,
  };
}

function complexitySkipped(): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: COMPLEXITY_ID,
    severity: "warning",
    scopedPaths: [],
    outcome: "SKIPPED",
    reason: "NO_ATTRIBUTED_PATCH",
  };
}

function complexityUnavailable(
  reason: BuiltInUnavailableReason,
  scopedPaths: readonly string[] = [],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: COMPLEXITY_ID,
    severity: "warning",
    scopedPaths,
    outcome: "UNAVAILABLE",
    reason,
  };
}

function reviewUnavailable(turnId: string, reason: UnavailableReason): ReviewLevelResult {
  return {
    kind: "REVIEW",
    turnId,
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

function resultIdentity(result: ReviewResult): string {
  switch (result.kind) {
    case "RULE":
      return result.ruleId ?? "RULE";
    case "BUILT_IN":
      return result.checkId;
    case "REVIEW":
      return "REVIEW";
  }
}

const invalidConfigShape = [
  "version: 2",
  "thresholds:",
  "  error:",
  "    warn: 0.1",
  "    fail: 0.5",
  "  warning:",
  "    warn: 0.5",
].join("\n");

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
  ] as const)(
    "presents one aggregate with the $outcome rule, scope creep, and complexity for probability $probability",
    async ({ probability, outcome }) => {
      const { hooks, facade, policy, presenter, jev } = harness();
      jev.probability = probability;
      jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
      jev.probabilities.set(COMPLEXITY_ID, 0.1);

      await dispatch(hooks, idleEvent());

      expect(facade.calls).toEqual(["listMessages", "fetchDiff"]);
      expect(policy.calls).toEqual(["load"]);
      expect(jevIds(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
      expect(presenter.reviews).toHaveLength(1);
      expect(lastResults(presenter)).toEqual([
        ruleEvaluated("TEST-1", "error", outcome, probability, ["src/a.ts"]),
        builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
        complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
      ]);
      expect(lastReview(presenter).summary.verdict).toBe(outcome);
    },
  );

  test("skips every lane with no attributed patch and zero Jev calls", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.diffs = [];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      ruleSkipped("TEST-1", "error", "NO_ATTRIBUTED_PATCH"),
      builtInSkipped(),
      complexitySkipped(),
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: null,
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 3, unavailable: 0 },
    });
  });

  test("never invokes message mutation or prompt APIs", async () => {
    const { hooks, facade } = harness();

    await dispatch(hooks, idleEvent());

    expect(facade.forbidden).toEqual([]);
  });
});

describe("JevGuardPlugin operational failures", () => {
  test("reports a review-level MISSING_ATTRIBUTED_DIFF when the messages read fails", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    facade.failure = "messages";

    await dispatch(hooks, idleEvent());

    expect(policy.calls).toEqual([]);
    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(SESSION_ID, "MISSING_ATTRIBUTED_DIFF"),
    ]);
  });

  test("reports a review-level MISSING_ATTRIBUTED_DIFF when the diff read fails", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.failure = "diff";

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(SESSION_ID, "MISSING_ATTRIBUTED_DIFF"),
    ]);
  });

  test("runs both built-ins when the rules file is absent", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: null, config: null } };

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: true,
      counts: { pass: 2, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
    });
  });

  test("runs both built-ins when the rules read fails", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "FAILED", reason: "RULES_READ_FAILURE" };

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("keeps a parser-level INVALID_RULE as a rule result distinct from a review-level one", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: "not a rule document", config: null } };

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable(null, null, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("runs both built-ins with the fixed gates when the config YAML is malformed", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: VALID_RULE, config: "a: [unclosed" } };

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "INVALID_CONFIG"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("runs both built-ins when the config shape does not resolve", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: VALID_RULE, config: invalidConfigShape } };

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)[0]).toEqual(ruleUnavailable("TEST-1", "error", "INVALID_CONFIG"));
    expect(lastResults(presenter)[1]).toEqual(builtInEvaluated("PASS", 0.1, ["src/a.ts"]));
    expect(lastResults(presenter)[2]).toEqual(complexityEvaluated("PASS", 0.1, ["src/a.ts"]));
  });

  test("runs both built-ins when the config read fails", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.result = { status: "FAILED", reason: "CONFIG_READ_FAILURE" };

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_CONFIG"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("reports the rule and both built-ins as JEV_FAILURE when the port fails", async () => {
    const { hooks, presenter, jev } = harness();
    jev.fail = true;

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "JEV_FAILURE", ["src/a.ts"]),
      builtInUnavailable("JEV_FAILURE", ["src/a.ts"]),
      complexityUnavailable("JEV_FAILURE", ["src/a.ts"]),
    ]);
  });
});

describe("JevGuardPlugin deduplication and containment", () => {
  test("evaluates a repeated idle only once and presents one aggregate", async () => {
    const { hooks, presenter, jev } = harness();

    await dispatch(hooks, idleEvent());
    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(presenter.reviews).toHaveLength(1);
  });

  test("evaluates concurrent idle events only once", async () => {
    const { hooks, presenter, jev } = harness();

    await Promise.all([dispatch(hooks, idleEvent()), dispatch(hooks, idleEvent())]);

    expect(jevIds(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(presenter.reviews).toHaveLength(1);
  });

  test("contains a presentation failure without retry or replacement review", async () => {
    const { hooks, presenter, jev } = harness();
    presenter.fail = true;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jevIds(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(presenter.attempts).toBe(1);
    expect(presenter.reviews).toEqual([]);
  });

  test("degrades only the rule lane when the loader rejects unexpectedly", async () => {
    const { hooks, policy, presenter, jev } = harness();
    policy.failure = new Error("programming bug");

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(policy.calls).toEqual(["load"]);
    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(presenter.attempts).toBe(1);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
    expect(JSON.stringify(lastReview(presenter))).not.toContain("programming bug");
  });

  test("keeps handling later idle events after a contained failure", async () => {
    const { hooks, facade, presenter, jev } = harness();
    facade.failure = "messages";

    await dispatch(hooks, idleEvent());
    expect(jev.requests).toHaveLength(0);
    expect(presenter.reviews).toHaveLength(1);

    facade.failure = "none";
    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(presenter.reviews).toHaveLength(2);
    expect(lastResults(presenter)[0]?.outcome).toBe("PASS");
  });
});

describe("JevGuardPlugin concurrency", () => {
  test("caps in-flight Jev calls at two across the rule lane and both built-ins", async () => {
    const { hooks, policy, presenter, jev } = harness();
    loadRules(
      policy,
      [ruleText("SRC-1", "error", "src/**"), ruleText("SRC-2", "error", "src/**")].join("\n\n"),
    );
    jev.block = true;

    const pendingReview = dispatch(hooks, idleEvent());

    await jev.waitForActivations(2);

    expect(jev.maxActive).toBe(2);
    expect(jev.activations).toEqual(["SRC-1", SCOPE_CREEP_ID]);

    jev.release("SRC-1");
    await jev.waitForActivations(3);

    expect(jev.activations).toEqual(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(jev.maxActive).toBe(2);

    jev.release(COMPLEXITY_ID);
    await jev.waitForActivations(4);

    expect(jev.activations).toEqual(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "SRC-2"]);
    expect(jev.maxActive).toBe(2);

    jev.release();
    await pendingReview;

    expect(jev.maxActive).toBe(2);
    expect(lastResults(presenter).map(resultIdentity)).toEqual([
      "SRC-1",
      "SRC-2",
      SCOPE_CREEP_ID,
      COMPLEXITY_ID,
    ]);
  });

  test("keeps a rule failure from suppressing the sibling rule and both built-ins", async () => {
    const { hooks, policy, presenter, jev } = harness();
    loadRules(
      policy,
      [ruleText("SRC-1", "error", "src/**"), ruleText("SRC-2", "error", "src/**")].join("\n\n"),
    );
    jev.block = true;
    jev.failingIds.add(COMPLEXITY_ID);

    const pendingReview = dispatch(hooks, idleEvent());

    await jev.waitForActivations(2);

    expect(jev.activations).toEqual(["SRC-1", SCOPE_CREEP_ID]);
    expect(jev.maxActive).toBe(2);

    jev.release("SRC-1");
    await jev.waitForActivations(3);

    expect(jev.activations).toEqual(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(jev.maxActive).toBe(2);

    jev.release(COMPLEXITY_ID);
    await jev.waitForActivations(4);

    expect(jev.activations).toEqual(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "SRC-2"]);
    expect(jev.maxActive).toBe(2);

    jev.release();
    await pendingReview;

    expect(jev.maxActive).toBeLessThanOrEqual(2);
    expect(lastResults(presenter)).toEqual([
      ruleEvaluated("SRC-1", "error", "PASS", 0.1, ["src/a.ts"]),
      ruleEvaluated("SRC-2", "error", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityUnavailable("JEV_FAILURE", ["src/a.ts"]),
    ]);
  });
});

describe("JevGuardPlugin multi-rule end-to-end", () => {
  test("calls Jev only for applicable rules plus both built-ins in deterministic result order", async () => {
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
    expect(jevIdSet(jev)).toEqual(new Set(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "GLOBAL-3"]));
    expect(lastResults(presenter).map(resultIdentity)).toEqual([
      "SRC-1",
      "TEST-2",
      "GLOBAL-3",
      SCOPE_CREEP_ID,
      COMPLEXITY_ID,
    ]);
    expect(lastResults(presenter).map((result) => result.outcome)).toEqual([
      "PASS",
      "SKIPPED",
      "PASS",
      "PASS",
      "PASS",
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: false,
      counts: { pass: 4, warn: 0, fail: 0, skipped: 1, unavailable: 0 },
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

    expect(jevIdSet(jev)).toEqual(new Set(["GOOD-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "GOOD-3"]));
    expect(lastResults(presenter)).toEqual([
      ruleEvaluated("GOOD-1", "error", "PASS", 0.1, ["src/a.ts"]),
      ruleUnavailable("BAD-2", null, "INVALID_RULE"),
      ruleEvaluated("GOOD-3", "warning", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: true,
      counts: { pass: 4, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
    });
  });

  test("records duplicate rule IDs as invalid and still runs both built-ins", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const rules = [ruleText("DUP-1", "error", "src/**"), ruleText("DUP-1", "error", "src/**")].join(
      "\n\n",
    );
    loadRules(policy, rules);

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("DUP-1", null, "INVALID_RULE"),
      ruleUnavailable("DUP-1", null, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("does not suppress later rules or built-ins after a single Jev failure", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const rules = [ruleText("FAIL-1", "error", "src/**"), ruleText("OK-2", "error", "src/**")].join(
      "\n\n",
    );
    loadRules(policy, rules);
    jev.failingIds.add("FAIL-1");

    await dispatch(hooks, idleEvent());

    expect(jevIdSet(jev)).toEqual(new Set(["FAIL-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "OK-2"]));
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("FAIL-1", "error", "JEV_FAILURE", ["src/a.ts"]),
      ruleEvaluated("OK-2", "error", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("does not suppress scope creep when only complexity fails", async () => {
    const { hooks, policy, presenter, jev } = harness();
    loadRules(policy, ruleText("OK-1", "error", "src/**"));
    jev.failingIds.add(COMPLEXITY_ID);

    await dispatch(hooks, idleEvent());

    expect(jevIdSet(jev)).toEqual(new Set(["OK-1", SCOPE_CREEP_ID, COMPLEXITY_ID]));
    expect(lastResults(presenter)).toEqual([
      ruleEvaluated("OK-1", "error", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityUnavailable("JEV_FAILURE", ["src/a.ts"]),
    ]);
  });

  test("keeps blocked, oversized, and clean rule evidence independent with built-in results", async () => {
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

    expect(jevIds(jev)).toEqual(["CLEAN-3"]);
    expect(lastResults(presenter).map((result) => result.outcome)).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
      "PASS",
      "UNAVAILABLE",
      "UNAVAILABLE",
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
    expect(lastResults(presenter)[3]).toEqual(builtInUnavailable("OVERSIZED_DIFF"));
    expect(lastResults(presenter)[4]).toEqual(complexityUnavailable("OVERSIZED_DIFF"));
  });

  test("reports the invalid config once per rule and still runs both built-ins", async () => {
    const { hooks, policy, presenter, jev } = harness();
    const rules = [ruleText("A-1", "error", "src/**"), ruleText("B-2", "warning", null)].join(
      "\n\n",
    );
    loadRules(policy, rules, invalidConfigShape);

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("A-1", "error", "INVALID_CONFIG"),
      ruleUnavailable("B-2", "warning", "INVALID_CONFIG"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("deduplicates repeated idles to one aggregate", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    const rules = [
      ruleText("SRC-1", "error", "src/**"),
      ruleText("GLOBAL-2", "warning", null),
    ].join("\n\n");
    loadRules(policy, rules);
    facade.diffs = [{ file: "src/a.ts", patch: PATCH }];

    await dispatch(hooks, idleEvent());
    await dispatch(hooks, idleEvent());

    expect(jevIdSet(jev)).toEqual(new Set(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "GLOBAL-2"]));
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
      jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
      jev.probabilities.set(COMPLEXITY_ID, 0.1);

      await dispatch(hooks, idleEvent());

      expect(jevIds(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
      expect(lastResults(presenter)[0]).toEqual(
        ruleEvaluated("TEST-1", severity, outcome, probability, ["src/a.ts"]),
      );
      expect(lastReview(presenter).summary.verdict).toBe(outcome);
    },
  );
});

describe("JevGuardPlugin runtime short-circuits", () => {
  test("skips an out-of-scope rule while still evaluating both built-ins", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [{ file: "docs/readme.md", patch: DOCS_SENTINEL }];

    await dispatch(hooks, idleEvent());

    expect(jevIds(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      ruleSkipped("TEST-1", "error", "NO_SCOPE_MATCH"),
      builtInEvaluated("PASS", 0.1, ["docs/readme.md"]),
      complexityEvaluated("PASS", 0.1, ["docs/readme.md"]),
    ]);
  });

  test("reports an oversized patch as UNAVAILABLE in every lane without a Jev call", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1) },
    ];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "OVERSIZED_DIFF"),
      builtInUnavailable("OVERSIZED_DIFF"),
      complexityUnavailable("OVERSIZED_DIFF"),
    ]);
  });

  test("reports a blocked file as UNAVAILABLE in every lane without a Jev call", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "src/.env", patch: "SECRET=1" },
    ];

    await dispatch(hooks, idleEvent());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "BLOCKED_EVIDENCE"),
      builtInUnavailable("BLOCKED_EVIDENCE"),
      complexityUnavailable("BLOCKED_EVIDENCE"),
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
    expect(lastResults(presenter)[1]).toMatchObject({
      kind: "BUILT_IN",
      checkId: SCOPE_CREEP_ID,
      outcome: "FAIL",
    });
    expect(lastResults(presenter)[2]).toMatchObject({
      kind: "BUILT_IN",
      checkId: COMPLEXITY_ID,
      severity: "warning",
      outcome: "WARN",
    });
    expect(lastReview(presenter).summary.verdict).toBe("FAIL");
    expect(facade.forbidden).toEqual([]);
  });

  test("resolves the UNAVAILABLE flow without mutating agent messages", async () => {
    const { hooks, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    jev.fail = true;

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(jev.requests).toHaveLength(3);
    expect(lastResults(presenter)[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(lastResults(presenter)[1]).toMatchObject({
      checkId: SCOPE_CREEP_ID,
      outcome: "UNAVAILABLE",
    });
    expect(lastResults(presenter)[2]).toMatchObject({
      checkId: COMPLEXITY_ID,
      outcome: "UNAVAILABLE",
    });
    expect(facade.forbidden).toEqual([]);
  });
});
