import { describe, expect, test } from "vitest";
import type {
  ConfigParseResult,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleEvaluationResult,
  JevRuleRequest,
  PolicyLoader,
  PolicyLoadResult,
  ReviewResult,
  Turn,
} from "../src/index";
import { checkRules, DEFAULT_EVIDENCE_POLICY } from "../src/index";

const PATCH =
  "--- a/src/auth/login.ts\n+++ b/src/auth/login.ts\n@@ -1 +1 @@\n-a\n+const limit = 5;\n";

class FakeJevPort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];

  constructor(private readonly failingCalls: readonly number[] = []) {}

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    const call = this.requests.length;
    this.requests.push(request);

    if (request.kind === "BUILT_IN_BATCH") {
      const answer = { status: "EVALUATED", noul: { violationProbability: 0.1 } } as const;

      return {
        kind: "BUILT_IN_BATCH",
        status: "EVALUATED",
        answers: { scopeCreep: answer, complexity: answer },
      };
    }

    if (this.failingCalls.includes(call)) {
      return { kind: "RULE", status: "FAILED", reason: "API_ERROR" };
    }

    return { kind: "RULE", status: "EVALUATED", noul: { violationProbability: 0.1 } };
  }

  async evaluateRuleBatch(
    requests: readonly JevRuleRequest[],
  ): Promise<readonly JevRuleEvaluationResult[]> {
    const results = await Promise.all(requests.map((request) => this.evaluate(request)));

    return results.map((result) =>
      result.kind === "RULE"
        ? result
        : { kind: "RULE", status: "FAILED", reason: "INVALID_RESPONSE" },
    );
  }
}

class FakePolicyLoader implements PolicyLoader {
  constructor(private readonly outcome: PolicyLoadResult | Error) {}

  async load(): Promise<PolicyLoadResult> {
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    return this.outcome;
  }
}

function loaded(rules: string | null, config: string | null = null): PolicyLoadResult {
  return { status: "LOADED", source: { rules, config } };
}

function rule(id: string, scope = "src/**"): string {
  return [
    `## ${id}`,
    "",
    "severity: error",
    `scope: ${scope}`,
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
    "Supporting changes.",
  ].join("\n");
}

function document(...blocks: readonly string[]): string {
  return blocks.join("\n\n");
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "rules-check",
    task: "Add rate limiting to the login endpoint.",
    files: [{ path: "src/auth/login.ts", patch: PATCH }],
    ...overrides,
  };
}

const parsed = (value: unknown) => (): ConfigParseResult => ({ status: "PARSED", value });

const invalidParser = (): ConfigParseResult => ({ status: "INVALID", reason: "INVALID_CONFIG" });

function reviewed(outcome: Awaited<ReturnType<typeof checkRules>>): readonly ReviewResult[] {
  if (outcome.status !== "REVIEWED") {
    throw new Error(`expected REVIEWED, got ${outcome.status}`);
  }

  return outcome.review.results;
}

function summarize(results: readonly ReviewResult[]): readonly string[] {
  return results.map((result) => {
    const name = result.kind === "RULE" ? (result.ruleId ?? "RULE") : result.kind;
    const detail = "reason" in result ? `/${result.reason}` : "";

    return `${name}:${result.outcome}${detail}`;
  });
}

function ruleIdsRequested(jev: FakeJevPort): readonly string[] {
  return jev.requests.flatMap((request) =>
    request.kind === "RULE" ? [request.question.criteria.id] : [],
  );
}

describe("checkRules", () => {
  test("evaluates every rule without a built-in request when no rule is selected", async () => {
    const jev = new FakeJevPort();
    const policy = new FakePolicyLoader(loaded(document(rule("A-1"), rule("B-2"))));

    const outcome = await checkRules(
      { turn: makeTurn(), ruleId: null },
      { policy, parseConfig: parsed(null), jev },
    );

    expect(summarize(reviewed(outcome))).toEqual(["A-1:PASS", "B-2:PASS"]);
    expect(ruleIdsRequested(jev)).toEqual(["A-1", "B-2"]);
    expect(jev.requests.some((request) => request.kind === "BUILT_IN_BATCH")).toBe(false);
  });

  test("restricts evaluation to the selected rule before calling Jev", async () => {
    const jev = new FakeJevPort();
    const policy = new FakePolicyLoader(loaded(document(rule("A-1"), rule("B-2"))));

    const outcome = await checkRules(
      { turn: makeTurn(), ruleId: "B-2" },
      { policy, parseConfig: parsed(null), jev },
    );

    expect(summarize(reviewed(outcome))).toEqual(["B-2:PASS"]);
    expect(ruleIdsRequested(jev)).toEqual(["B-2"]);
  });

  test("reports an unknown rule id without calling Jev", async () => {
    const jev = new FakeJevPort();
    const policy = new FakePolicyLoader(loaded(rule("A-1")));

    const outcome = await checkRules(
      { turn: makeTurn(), ruleId: "NOPE-9" },
      { policy, parseConfig: parsed(null), jev },
    );

    expect(outcome).toEqual({ status: "RULE_NOT_FOUND" });
    expect(jev.requests).toHaveLength(0);
  });

  test("a selected invalid rule block is UNAVAILABLE/INVALID_RULE without Jev", async () => {
    const jev = new FakeJevPort();
    const broken = ["## BAD-1", "", "### Rule", "", "No severity."].join("\n");
    const policy = new FakePolicyLoader(loaded(document(rule("A-1"), broken)));

    const outcome = await checkRules(
      { turn: makeTurn(), ruleId: "BAD-1" },
      { policy, parseConfig: parsed(null), jev },
    );

    expect(summarize(reviewed(outcome))).toEqual(["BAD-1:UNAVAILABLE/INVALID_RULE"]);
    expect(jev.requests).toHaveLength(0);
  });

  test("a turn without files is SKIPPED/NO_ATTRIBUTED_PATCH without Jev", async () => {
    const jev = new FakeJevPort();
    const policy = new FakePolicyLoader(loaded(rule("A-1")));

    const outcome = await checkRules(
      { turn: makeTurn({ files: [] }), ruleId: null },
      { policy, parseConfig: parsed(null), jev },
    );

    expect(summarize(reviewed(outcome))).toEqual(["A-1:SKIPPED/NO_ATTRIBUTED_PATCH"]);
    expect(jev.requests).toHaveLength(0);
  });

  test("a file outside the rule scope is SKIPPED/NO_SCOPE_MATCH without Jev", async () => {
    const jev = new FakeJevPort();
    const policy = new FakePolicyLoader(loaded(rule("A-1", "docs/**")));

    const outcome = await checkRules(
      { turn: makeTurn(), ruleId: null },
      { policy, parseConfig: parsed(null), jev },
    );

    expect(summarize(reviewed(outcome))).toEqual(["A-1:SKIPPED/NO_SCOPE_MATCH"]);
    expect(jev.requests).toHaveLength(0);
  });

  test.each(["src/config/server.pem", "src/.env"])(
    "a denylisted scoped path %s is UNAVAILABLE/BLOCKED_EVIDENCE without Jev",
    async (path) => {
      const jev = new FakeJevPort();
      const policy = new FakePolicyLoader(loaded(rule("A-1")));

      const outcome = await checkRules(
        { turn: makeTurn({ files: [{ path, patch: PATCH }] }), ruleId: null },
        { policy, parseConfig: parsed(null), jev },
      );

      expect(summarize(reviewed(outcome))).toEqual(["A-1:UNAVAILABLE/BLOCKED_EVIDENCE"]);
      expect(jev.requests).toHaveLength(0);
    },
  );

  test("an invalid config makes the rule UNAVAILABLE/INVALID_CONFIG without Jev", async () => {
    const jev = new FakeJevPort();
    const policy = new FakePolicyLoader(loaded(rule("A-1"), "gate: nope"));

    const outcome = await checkRules(
      { turn: makeTurn(), ruleId: null },
      { policy, parseConfig: invalidParser, jev },
    );

    expect(summarize(reviewed(outcome))).toEqual(["A-1:UNAVAILABLE/INVALID_CONFIG"]);
    expect(jev.requests).toHaveLength(0);
  });

  test.each([
    ["a rejected loader", new Error("boom")],
    ["a failed load", { status: "FAILED", reason: "RULES_READ_FAILURE" } as const],
    ["absent rules", loaded(null)],
  ])(
    "%s degrades to a review-level UNAVAILABLE even with a rule id",
    async (_name, outcomeInput) => {
      const jev = new FakeJevPort();
      const policy = new FakePolicyLoader(outcomeInput);

      const outcome = await checkRules(
        { turn: makeTurn(), ruleId: "A-1" },
        { policy, parseConfig: parsed(null), jev },
      );

      expect(summarize(reviewed(outcome))).toEqual(["REVIEW:UNAVAILABLE/INVALID_RULE"]);
      expect(jev.requests).toHaveLength(0);
    },
  );

  test("a Jev failure is UNAVAILABLE/JEV_FAILURE", async () => {
    const jev = new FakeJevPort([0]);
    const policy = new FakePolicyLoader(loaded(rule("A-1")));

    const outcome = await checkRules(
      { turn: makeTurn(), ruleId: null },
      { policy, parseConfig: parsed(null), jev },
    );

    expect(summarize(reviewed(outcome))).toEqual(["A-1:UNAVAILABLE/JEV_FAILURE"]);
  });

  test("slices an oversized scoped diff with the same task and never emits a partial verdict", async () => {
    const body = `@@ -1 +1 @@\n+${"x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength / 2 + 10)}\n`;
    const files = ["src/a.ts", "src/b.ts"].map((path) => ({
      path,
      patch: `--- a/${path}\n+++ b/${path}\n${body}`,
    }));
    const task = "Sliced task text.";
    const okJev = new FakeJevPort();
    const policy = new FakePolicyLoader(loaded(rule("A-1")));

    const ok = await checkRules(
      { turn: makeTurn({ task, files }), ruleId: null },
      { policy, parseConfig: parsed(null), jev: okJev },
    );

    expect(summarize(reviewed(ok))).toEqual(["A-1:PASS"]);
    expect(okJev.requests).toHaveLength(2);
    expect(okJev.requests.map((request) => request.task)).toEqual([task, task]);

    const failingJev = new FakeJevPort([1]);

    const failed = await checkRules(
      { turn: makeTurn({ task, files }), ruleId: null },
      { policy, parseConfig: parsed(null), jev: failingJev },
    );

    expect(summarize(reviewed(failed))).toEqual(["A-1:UNAVAILABLE/JEV_FAILURE"]);
  });
});
