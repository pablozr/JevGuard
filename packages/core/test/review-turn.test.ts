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
import { COMPLEXITY_CHECK_ID, reviewTurn, SCOPE_CREEP_CHECK_ID } from "../src/index";

const PATCH = "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+const limit = 5;";

class FakeJevPort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];

  constructor(private readonly events: string[] = []) {}

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.events.push("jev");
    this.requests.push(request);

    if (request.kind === "BUILT_IN_BATCH") {
      const answer = { status: "EVALUATED", noul: { violationProbability: 0.1 } } as const;

      return {
        kind: "BUILT_IN_BATCH",
        status: "EVALUATED",
        answers: { scopeCreep: answer, complexity: answer },
      };
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
  loads = 0;

  constructor(
    private readonly outcome: PolicyLoadResult | Error,
    private readonly events: string[] = [],
  ) {}

  async load(): Promise<PolicyLoadResult> {
    this.loads += 1;
    this.events.push("load");

    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    return this.outcome;
  }
}

function loaded(rules: string | null, config: string | null = null): PolicyLoadResult {
  return { status: "LOADED", source: { rules, config } };
}

function rule(id: string): string {
  return [
    `## ${id}`,
    "",
    "severity: error",
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
    "Supporting changes.",
  ].join("\n");
}

function makeTurn(): Turn {
  return {
    id: "turn-1",
    task: "Add rate limiting to the login endpoint.",
    files: [{ path: "src/auth/login.ts", patch: PATCH }],
  };
}

const parsed = (value: unknown) => (): ConfigParseResult => ({ status: "PARSED", value });

const invalidParser = (): ConfigParseResult => ({ status: "INVALID", reason: "INVALID_CONFIG" });

function identity(result: ReviewResult): string {
  switch (result.kind) {
    case "RULE":
      return result.ruleId ?? "RULE";
    case "BUILT_IN":
      return result.checkId;
    case "REVIEW":
      return "REVIEW";
  }
}

function identities(results: readonly ReviewResult[]): readonly string[] {
  return results.map(identity);
}

function reviewLevelReason(results: readonly ReviewResult[]): string | null {
  const [first] = results;

  return first?.kind === "REVIEW" && first.outcome === "UNAVAILABLE" ? first.reason : null;
}

describe("reviewTurn", () => {
  test("a rejected load degrades only the rule lane and still evaluates built-ins", async () => {
    const jev = new FakeJevPort();
    const policy = new FakePolicyLoader(new Error("boom"));

    const outcome = await reviewTurn(makeTurn(), { policy, parseConfig: parsed(null), jev });

    expect(identities(outcome.review.results)).toEqual([
      "REVIEW",
      SCOPE_CREEP_CHECK_ID,
      COMPLEXITY_CHECK_ID,
    ]);
    expect(reviewLevelReason(outcome.review.results)).toBe("INVALID_RULE");
    expect(jev.requests).toHaveLength(1);
    expect(outcome.remediation.status).toBe("INVALID");
    expect(outcome.rules).toEqual([]);
  });

  test("a rules read failure is INVALID_RULE", async () => {
    const policy = new FakePolicyLoader({ status: "FAILED", reason: "RULES_READ_FAILURE" });

    const outcome = await reviewTurn(makeTurn(), {
      policy,
      parseConfig: parsed(null),
      jev: new FakeJevPort(),
    });

    expect(reviewLevelReason(outcome.review.results)).toBe("INVALID_RULE");
    expect(identities(outcome.review.results)).toEqual([
      "REVIEW",
      SCOPE_CREEP_CHECK_ID,
      COMPLEXITY_CHECK_ID,
    ]);
    expect(outcome.rules).toEqual([]);
    expect(outcome.remediation.status).toBe("INVALID");
  });

  test("a config read failure is INVALID_CONFIG", async () => {
    const policy = new FakePolicyLoader({ status: "FAILED", reason: "CONFIG_READ_FAILURE" });

    const outcome = await reviewTurn(makeTurn(), {
      policy,
      parseConfig: parsed(null),
      jev: new FakeJevPort(),
    });

    expect(reviewLevelReason(outcome.review.results)).toBe("INVALID_CONFIG");
    expect(identities(outcome.review.results)).toEqual([
      "REVIEW",
      SCOPE_CREEP_CHECK_ID,
      COMPLEXITY_CHECK_ID,
    ]);
    expect(outcome.rules).toEqual([]);
    expect(outcome.remediation.status).toBe("INVALID");
  });

  test("absent rules are INVALID_RULE while built-ins still run", async () => {
    const jev = new FakeJevPort();

    const outcome = await reviewTurn(makeTurn(), {
      policy: new FakePolicyLoader(loaded(null)),
      parseConfig: parsed(null),
      jev,
    });

    expect(reviewLevelReason(outcome.review.results)).toBe("INVALID_RULE");
    expect(identities(outcome.review.results)).toHaveLength(3);
    expect(outcome.rules).toEqual([]);
  });

  test("absent config selects the default remediation config", async () => {
    const outcome = await reviewTurn(makeTurn(), {
      policy: new FakePolicyLoader(loaded(rule("R-1"), null)),
      parseConfig: invalidParser,
      jev: new FakeJevPort(),
    });

    expect(outcome.remediation.status).toBe("VALID");
    expect(outcome.rules).toHaveLength(1);
  });

  test("an invalid config parse invalidates the gate and remediation", async () => {
    const outcome = await reviewTurn(makeTurn(), {
      policy: new FakePolicyLoader(loaded(rule("R-1"), "gate: [")),
      parseConfig: invalidParser,
      jev: new FakeJevPort(),
    });

    const [ruleResult] = outcome.review.results;

    expect(outcome.remediation.status).toBe("INVALID");
    expect(identities(outcome.review.results)).toEqual([
      "R-1",
      SCOPE_CREEP_CHECK_ID,
      COMPLEXITY_CHECK_ID,
    ]);
    expect(ruleResult).toMatchObject({
      kind: "RULE",
      outcome: "UNAVAILABLE",
      reason: "INVALID_CONFIG",
    });
  });

  test("orders rules in source order, then scope creep, then complexity", async () => {
    const rules = [rule("R-2"), rule("R-1")].join("\n\n");

    const outcome = await reviewTurn(makeTurn(), {
      policy: new FakePolicyLoader(loaded(rules)),
      parseConfig: parsed(null),
      jev: new FakeJevPort(),
    });

    expect(identities(outcome.review.results)).toEqual([
      "R-2",
      "R-1",
      SCOPE_CREEP_CHECK_ID,
      COMPLEXITY_CHECK_ID,
    ]);
    expect(outcome.remediation.status).toBe("VALID");
    expect(outcome.rules).toHaveLength(2);
  });

  test("loads the policy once, before any Jev call", async () => {
    const events: string[] = [];
    const policy = new FakePolicyLoader(loaded(rule("R-1")), events);
    const jev = new FakeJevPort(events);

    await reviewTurn(makeTurn(), { policy, parseConfig: parsed(null), jev });

    expect(policy.loads).toBe(1);
    expect(events[0]).toBe("load");
    expect(events.filter((event) => event === "load")).toHaveLength(1);
    expect(events.length).toBeGreaterThan(1);
  });
});
