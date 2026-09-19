import { describe, expect, test } from "vitest";
import { DEFAULT_EVIDENCE_POLICY, DEFAULT_GATE_CONFIG, evaluateRule } from "../src/index";
import type {
  EvaluateRuleInput,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  ParsedRule,
  Turn,
  TurnFile,
} from "../src/index";

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
    description: "HTTP controllers must not contain business logic.",
    violation: "A controller performs domain decisions directly.",
    allowed: null,
    ...overrides,
  };
}

function makeInput(overrides: Partial<EvaluateRuleInput> = {}): EvaluateRuleInput {
  return {
    turn: makeTurn(),
    rule: makeRule(),
    gateConfig: DEFAULT_GATE_CONFIG,
    evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    ...overrides,
  };
}

function evaluated(probability: number): JevEvaluationResult {
  return { status: "EVALUATED", noul: { violationProbability: probability } };
}

function firstRequest(port: FakeJevPort): JevRequest {
  const [request] = port.requests;

  if (request === undefined) {
    throw new Error("expected the port to receive a request");
  }

  return request;
}

const selectedContext = {
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

describe("evaluateRule request", () => {
  test("builds exactly one Noul with English criteria and a single Allowed", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const rule = makeRule({ allowed: ALLOWED });

    await evaluateRule(makeInput({ rule }), { jev: port });

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

    await evaluateRule(makeInput(), { jev: port });

    const request = firstRequest(port);

    expect("allowed" in request.question.criteria).toBe(false);
    expect(JSON.stringify(request)).not.toContain('"allowed"');
  });
});

describe("evaluateRule gate outcomes", () => {
  test.each([
    [0.1, "PASS"],
    [0.399, "PASS"],
    [0.4, "WARN"],
    [0.699, "WARN"],
    [0.7, "FAIL"],
    [1, "FAIL"],
  ] as const)("maps error probability %s to %s", async (probability, outcome) => {
    const port = new FakeJevPort(evaluated(probability));

    const result = await evaluateRule(makeInput(), { jev: port });

    expect(result).toEqual({ ...selectedContext, outcome, violationProbability: probability });
    expect(port.requests).toHaveLength(1);
  });

  test("a warning rule warns at the boundary and never fails", async () => {
    const rule = makeRule({ severity: "warning" });

    const pass = await evaluateRule(makeInput({ rule }), {
      jev: new FakeJevPort(evaluated(0.599)),
    });
    const warn = await evaluateRule(makeInput({ rule }), {
      jev: new FakeJevPort(evaluated(0.999)),
    });

    expect(pass).toEqual({
      ...selectedContext,
      severity: "warning",
      outcome: "PASS",
      violationProbability: 0.599,
    });
    expect(warn).toEqual({
      ...selectedContext,
      severity: "warning",
      outcome: "WARN",
      violationProbability: 0.999,
    });
  });
});

describe("evaluateRule short-circuits", () => {
  test("skips without calling the port when the turn has no attributed patch", async () => {
    const port = new FakeJevPort(evaluated(0.1));

    const result = await evaluateRule(makeInput({ turn: makeTurn({ files: [] }) }), { jev: port });

    expect(result).toEqual({
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
    const rule = makeRule({ scope: "src/**" });

    const result = await evaluateRule(makeInput({ turn, rule }), { jev: port });

    expect(result).toEqual({
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

    const result = await evaluateRule(makeInput({ turn }), { jev: port });

    expect(result).toEqual({
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

    const result = await evaluateRule(makeInput({ evidencePolicy }), { jev: port });

    expect(result).toEqual({
      ...selectedContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(port.requests).toHaveLength(0);
  });
});

describe("evaluateRule port failures", () => {
  test("converts a typed failure into UNAVAILABLE without a gate outcome", async () => {
    const port = new FakeJevPort({ status: "FAILED", reason: "MISSING_CREDENTIAL" });

    const result = await evaluateRule(makeInput(), { jev: port });

    expect(result).toEqual(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test("contains a rejected port promise as UNAVAILABLE instead of throwing", async () => {
    const port = new FakeJevPort(new Error("transport down"));

    await expect(evaluateRule(makeInput(), { jev: port })).resolves.toEqual(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test.each([1.5, -0.1, Number.NaN])(
    "treats an evaluated probability of %s as UNAVAILABLE",
    async (probability) => {
      const port = new FakeJevPort(evaluated(probability));

      const result = await evaluateRule(makeInput(), { jev: port });

      expect(result).toEqual(unavailable);
      expect(port.requests).toHaveLength(1);
    },
  );
});

describe("evaluateRule context", () => {
  test("records the turn, rule, severity, and only the scoped paths", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const turn = makeTurn({
      files: [file("src/a.ts", "patch-src"), file("docs/readme.md", "patch-docs")],
    });
    const rule = makeRule({ scope: "src/**", severity: "warning" });

    const result = await evaluateRule(makeInput({ turn, rule }), { jev: port });

    expect(result).toMatchObject({
      turnId: "turn-1",
      ruleId: "ARCH-001",
      severity: "warning",
      scopedPaths: ["src/a.ts"],
    });
    expect(firstRequest(port).change.files).toEqual(["src/a.ts"]);
  });
});
