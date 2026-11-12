import { describe, expect, test } from "vitest";
import type {
  GateConfig,
  EvidencePolicy,
  ReviewResult,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleEvaluationResult,
  JevRuleRequest,
  ParsedRule,
  Turn,
  TurnFile,
} from "../src/index";
import { DEFAULT_EVIDENCE_POLICY, DEFAULT_GATE_CONFIG, evaluateRules } from "../src/index";

const LOGIN_PATCH = "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+const limit = 5;";
const ALLOWED = "Validation, HTTP mapping, and delegation to services.";

class FakeJevPort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];

  constructor(private readonly outcome: JevEvaluationResult | Error) {}

  evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    return this.outcome instanceof Error
      ? Promise.reject(this.outcome)
      : Promise.resolve(this.outcome);
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

function file(path: string, patch: string): TurnFile {
  return { path, patch };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    task: "Add rate limiting to the login endpoint.",
    files: [file("src/auth/login.ts", LOGIN_PATCH)],
    ...overrides,
  };
}

function makeRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: "ARCH-001",
    severity: "error",
    scope: null,
    evidence: "code",
    description: "HTTP controllers must not contain business logic.",
    violation: "A controller performs domain decisions directly.",
    allowed: null,
    ...overrides,
  };
}

interface SingleRuleInput {
  readonly turn: Turn;
  readonly rule: ParsedRule;
  readonly gateConfig: GateConfig;
  readonly evidencePolicy: EvidencePolicy;
}

async function evaluateOne(input: SingleRuleInput, jev: JevEvaluationPort): Promise<ReviewResult> {
  const review = await evaluateRules(
    {
      turn: input.turn,
      rules: [{ status: "PARSED", rule: input.rule }],
      gateConfig: { status: "VALID", config: input.gateConfig },
      evidencePolicy: input.evidencePolicy,
    },
    { jev },
  );
  const [result] = review.results;

  if (result === undefined) {
    throw new Error("expected one rule result");
  }

  return result;
}

function makeInput(overrides: Partial<SingleRuleInput> = {}): SingleRuleInput {
  return {
    turn: makeTurn(),
    rule: makeRule(),
    gateConfig: DEFAULT_GATE_CONFIG,
    evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    ...overrides,
  };
}

function evaluated(probability: number): JevEvaluationResult {
  return { kind: "RULE", status: "EVALUATED", noul: { violationProbability: probability } };
}

function firstRequest(port: FakeJevPort): JevRuleRequest {
  const [request] = port.requests;

  if (request === undefined || request.kind !== "RULE") {
    throw new Error("expected the port to receive a rule request");
  }

  return request;
}

const selectedContext = {
  kind: "RULE",
  turnId: "turn-1",
  ruleId: "ARCH-001",
  severity: "error",
  scopedPaths: ["src/auth/login.ts"],
};

const unavailable = {
  ...selectedContext,
  outcome: "UNAVAILABLE",
  reason: "JEV_FAILURE",
};

describe("evaluateRules single rule request", () => {
  test("builds exactly one Noul with English criteria and a single Allowed", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const rule = makeRule({ allowed: ALLOWED });

    await evaluateOne(makeInput({ rule }), port);

    expect(port.requests).toHaveLength(1);

    const request = firstRequest(port);

    expect(request.task).toBe("Add rate limiting to the login endpoint.");
    expect(request.question.type).toBe("noul");
    expect(request.question.instructions).toContain("true");
    expect(request.question.instructions).toContain("false");
    expect(request.question.criteria).toEqual({
      id: "ARCH-001",
      description: "HTTP controllers must not contain business logic.",
      violation: "A controller performs domain decisions directly.",
      allowed: ALLOWED,
    });
    expect(request.change).toEqual({ files: ["src/auth/login.ts"], diff: LOGIN_PATCH });
    expect(JSON.stringify(request).split(ALLOWED)).toHaveLength(2);
  });

  test("omits the allowed criterion when the rule has no exception", async () => {
    const port = new FakeJevPort(evaluated(0.1));

    await evaluateOne(makeInput(), port);

    const request = firstRequest(port);

    expect("allowed" in request.question.criteria).toBe(false);
    expect(JSON.stringify(request)).not.toContain('"allowed"');
  });
});

describe("evaluateRules single rule gate outcomes", () => {
  test.each([
    [0.1, "PASS"],
    [0.399, "PASS"],
    [0.4, "WARN"],
    [0.699, "WARN"],
    [0.7, "FAIL"],
    [1, "FAIL"],
  ] as const)("maps error probability %s to %s", async (probability, outcome) => {
    const port = new FakeJevPort(evaluated(probability));

    const result = await evaluateOne(makeInput(), port);

    expect(result).toMatchObject({
      ...selectedContext,
      outcome,
      violationProbability: probability,
    });
    expect(port.requests).toHaveLength(1);
  });

  test("a warning rule warns at the boundary and never fails", async () => {
    const rule = makeRule({ severity: "warning" });

    const pass = await evaluateOne(makeInput({ rule }), new FakeJevPort(evaluated(0.599)));
    const warn = await evaluateOne(makeInput({ rule }), new FakeJevPort(evaluated(0.999)));

    expect(pass).toMatchObject({
      ...selectedContext,
      severity: "warning",
      outcome: "PASS",
      violationProbability: 0.599,
    });
    expect(warn).toMatchObject({
      ...selectedContext,
      severity: "warning",
      outcome: "WARN",
      violationProbability: 0.999,
    });
  });
});

describe("evaluateRules single rule short-circuits", () => {
  test("skips without calling the port when the turn has no attributed patch", async () => {
    const port = new FakeJevPort(evaluated(0.1));

    const result = await evaluateOne(makeInput({ turn: makeTurn({ files: [] }) }), port);

    expect(result).toMatchObject({
      ...selectedContext,
      scopedPaths: [],
      outcome: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
    expect(port.requests).toHaveLength(0);
  });

  test("skips without calling the port when the scope matches no changed file", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const turn = makeTurn({ files: [file("docs/readme.md", "patch-docs")] });
    const rule = makeRule({ scope: { include: ["src/**"], exclude: [] } });

    const result = await evaluateOne(makeInput({ turn, rule }), port);

    expect(result).toMatchObject({
      ...selectedContext,
      scopedPaths: [],
      outcome: "SKIPPED",
      reason: "NO_SCOPE_MATCH",
    });
    expect(port.requests).toHaveLength(0);
  });

  test("reports blocked evidence without calling the port", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const turn = makeTurn({ files: [file("src/.env", "SECRET=1")] });

    const result = await evaluateOne(makeInput({ turn }), port);

    expect(result).toMatchObject({
      ...selectedContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
    expect(port.requests).toHaveLength(0);
  });

  test("reports an oversized diff without calling the port", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const evidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 4 };

    const result = await evaluateOne(makeInput({ evidencePolicy }), port);

    expect(result).toMatchObject({
      ...selectedContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(port.requests).toHaveLength(0);
  });
});

describe("evaluateRules single rule port failures", () => {
  test("converts a typed failure into UNAVAILABLE without a gate outcome", async () => {
    const port = new FakeJevPort({ kind: "RULE", status: "FAILED", reason: "MISSING_CREDENTIAL" });

    const result = await evaluateOne(makeInput(), port);

    expect(result).toMatchObject(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test("contains a rejected port promise as UNAVAILABLE instead of throwing", async () => {
    const port = new FakeJevPort(new Error("transport down"));

    await expect(evaluateOne(makeInput(), port)).resolves.toMatchObject(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test.each([1.5, -0.1, Number.NaN])(
    "treats an evaluated probability of %s as UNAVAILABLE",
    async (probability) => {
      const port = new FakeJevPort(evaluated(probability));

      const result = await evaluateOne(makeInput(), port);

      expect(result).toMatchObject(unavailable);
      expect(port.requests).toHaveLength(1);
    },
  );
});

describe("evaluateRules single rule context", () => {
  test("records the turn, rule, severity, and only the scoped paths", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-src"), file("docs/readme.md", "patch-docs")],
    });
    const rule = makeRule({
      scope: { include: ["src/**"], exclude: [] },
      severity: "warning",
    });

    const result = await evaluateOne(makeInput({ turn, rule }), port);

    expect(result).toMatchObject({
      turnId: "turn-1",
      ruleId: "ARCH-001",
      severity: "warning",
      scopedPaths: ["src/a.ts"],
    });
    expect(firstRequest(port).change.files).toEqual(["src/a.ts"]);
  });
});
