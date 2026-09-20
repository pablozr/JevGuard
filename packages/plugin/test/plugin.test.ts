import type {
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  ReviewResult,
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

class FakeFacade implements OpenCodeSessionFacade {
  readonly calls: string[] = [];
  readonly forbidden: string[] = [];
  records: readonly OpenCodeMessageRecord[] = turnRecords();
  diffs: readonly OpenCodeFileDiff[] = patchDiffs();
  failure: "none" | "messages" | "diff" = "none";

  async listMessages(): Promise<readonly OpenCodeMessageRecord[]> {
    this.calls.push("listMessages");

    if (this.failure === "messages") {
      throw new Error("messages unavailable");
    }

    return this.records;
  }

  async fetchDiff(): Promise<readonly OpenCodeFileDiff[]> {
    this.calls.push("fetchDiff");

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
    const { hooks, facade, presenter } = harness();
    facade.failure = "diff";

    await dispatch(hooks, idleEvent());

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
    const { hooks, policy, presenter } = harness();
    policy.result = { status: "FAILED", reason: "RULES_READ_FAILURE" };

    await dispatch(hooks, idleEvent());

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
    const { hooks, policy, presenter } = harness();
    policy.result = { status: "LOADED", source: { rules: "not a rule document", config: null } };

    await dispatch(hooks, idleEvent());

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
    const { hooks, policy, presenter } = harness();
    policy.result = { status: "LOADED", source: { rules: VALID_RULE, config: "a: [unclosed" } };

    await dispatch(hooks, idleEvent());

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
    const { hooks, policy, presenter } = harness();
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
    const { hooks, policy, presenter } = harness();
    policy.result = { status: "FAILED", reason: "CONFIG_READ_FAILURE" };

    await dispatch(hooks, idleEvent());

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
    const { hooks, policy, presenter } = harness();
    policy.failure = new Error("programming bug");

    await expect(dispatch(hooks, idleEvent())).resolves.toBeUndefined();

    expect(presenter.attempts).toBe(0);
    expect(presenter.results).toEqual([]);
  });

  test("keeps handling later idle events after a contained failure", async () => {
    const { hooks, facade, presenter } = harness();
    facade.failure = "messages";

    await dispatch(hooks, idleEvent());
    expect(presenter.results).toHaveLength(1);

    facade.failure = "none";
    await dispatch(hooks, idleEvent());

    expect(presenter.results).toHaveLength(2);
    expect(presenter.results[1]?.outcome).toBe("PASS");
  });
});
