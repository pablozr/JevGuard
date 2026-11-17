import { describe, expect, test } from "vitest";
import type {
  EvaluateBuiltInsInput,
  JevBuiltInAnswerResult,
  JevBuiltInBatchRequest,
  JevBuiltInBatchResult,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleEvaluationResult,
  JevRuleRequest,
  Turn,
  TurnFile,
} from "../src/index";
import {
  buildBuiltInBatchRequest,
  COMPLEXITY_CHECK_ID,
  DEFAULT_EVIDENCE_POLICY,
  evaluateBuiltIns,
  SCOPE_CREEP_CHECK_ID,
  TEST_ADEQUACY_CHECK_ID,
} from "../src/index";

const LOGIN_PATCH = "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+const limit = 5;";
const DOCS_PATCH = "diff --git a/docs/readme.md b/docs/readme.md\n+Documentation.";
const CONFIG_PATCH = "diff --git a/config/app.yaml b/config/app.yaml\n+feature: on";

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
    files: [file("src/auth/login.ts", LOGIN_PATCH), file("docs/readme.md", DOCS_PATCH)],
    ...overrides,
  };
}

function makeInput(overrides: Partial<EvaluateBuiltInsInput> = {}): EvaluateBuiltInsInput {
  return {
    turn: makeTurn(),
    evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    ...overrides,
  };
}

function evaluated(probability: number): JevBuiltInAnswerResult {
  return { status: "EVALUATED", noul: { violationProbability: probability } };
}

function answerFailed(): JevBuiltInAnswerResult {
  return { status: "FAILED", reason: "INVALID_RESPONSE" };
}

function batchEvaluated(
  scopeCreep: JevBuiltInAnswerResult,
  complexity: JevBuiltInAnswerResult,
  testAdequacy: JevBuiltInAnswerResult = evaluated(0.1),
): JevBuiltInBatchResult {
  return {
    kind: "BUILT_IN_BATCH",
    status: "EVALUATED",
    answers: { scopeCreep, complexity, testAdequacy },
  };
}

function batchFailed(
  reason: "MISSING_CREDENTIAL" | "API_ERROR" | "INVALID_RESPONSE",
): JevBuiltInBatchResult {
  return { kind: "BUILT_IN_BATCH", status: "FAILED", reason };
}

function firstRequest(port: FakeJevPort): JevBuiltInBatchRequest {
  const [request] = port.requests;

  if (request === undefined || request.kind !== "BUILT_IN_BATCH") {
    throw new Error("expected a built-in batch request");
  }

  return request;
}

const selectedPaths = ["src/auth/login.ts", "docs/readme.md"];

const scopeCreepContext = {
  kind: "BUILT_IN",
  turnId: "turn-1",
  ruleId: null,
  checkId: SCOPE_CREEP_CHECK_ID,
  severity: "error",
  scopedPaths: selectedPaths,
};

const complexityContext = {
  kind: "BUILT_IN",
  turnId: "turn-1",
  ruleId: null,
  checkId: COMPLEXITY_CHECK_ID,
  severity: "warning",
  scopedPaths: selectedPaths,
};

const testAdequacyContext = {
  kind: "BUILT_IN",
  turnId: "turn-1",
  ruleId: null,
  checkId: TEST_ADEQUACY_CHECK_ID,
  severity: "warning",
  scopedPaths: selectedPaths,
};

describe("built-in batch request", () => {
  test("builds one request with every named Noul, the task, and the complete change", () => {
    const request = buildBuiltInBatchRequest("Add rate limiting.", {
      files: selectedPaths,
      diff: `${LOGIN_PATCH}\n${DOCS_PATCH}`,
    });

    expect(request.kind).toBe("BUILT_IN_BATCH");
    expect(request.task).toBe("Add rate limiting.");
    expect(request.questions.scopeCreep.type).toBe("noul");
    expect(request.questions.scopeCreep.criteria.id).toBe(SCOPE_CREEP_CHECK_ID);
    expect(request.questions.scopeCreep.criteria.allowed).toContain("supporting");
    expect(request.questions.complexity.type).toBe("noul");
    expect(request.questions.complexity.criteria.id).toBe(COMPLEXITY_CHECK_ID);
    expect(request.questions.complexity.criteria.allowed).toContain(
      "explicitly required by the task",
    );
    expect(request.questions.testAdequacy.type).toBe("noul");
    expect(request.questions.testAdequacy.criteria.id).toBe(TEST_ADEQUACY_CHECK_ID);
    expect(request.questions.testAdequacy.criteria.allowed).toContain("changes with no behavior");
    expect(request.change).toEqual({
      files: selectedPaths,
      diff: `${LOGIN_PATCH}\n${DOCS_PATCH}`,
    });
  });
});

describe("built-in batch evaluation", () => {
  test("sends every attributed path and the task once without scope filtering", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));
    const turn = makeTurn({
      files: [
        file("src/auth/login.ts", LOGIN_PATCH),
        file("docs/readme.md", DOCS_PATCH),
        file("config/app.yaml", CONFIG_PATCH),
      ],
    });

    await evaluateBuiltIns(makeInput({ turn }), { jev: port });

    expect(port.requests).toHaveLength(1);

    const request = firstRequest(port);

    expect(request.task).toBe("Add rate limiting to the login endpoint.");
    expect(request.change.files).toEqual([
      "src/auth/login.ts",
      "docs/readme.md",
      "config/app.yaml",
    ]);
    expect(request.change.diff).toBe(`${LOGIN_PATCH}\n${DOCS_PATCH}\n${CONFIG_PATCH}`);
  });

  test("selects evidence once and issues exactly one request for every check", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(port.requests).toHaveLength(1);
    expect(result).toEqual({
      scopeCreep: { ...scopeCreepContext, outcome: "PASS", violationProbability: 0.1 },
      complexity: { ...complexityContext, outcome: "PASS", violationProbability: 0.1 },
      testAdequacy: { ...testAdequacyContext, outcome: "PASS", violationProbability: 0.1 },
    });
  });

  test.each([
    [0, "PASS"],
    [0.649, "PASS"],
    [0.65, "WARN"],
    [0.899, "WARN"],
    [0.9, "FAIL"],
    [1, "FAIL"],
  ] as const)(
    "maps a scope-creep answer of %s to %s on the fixed error gate",
    async (probability, outcome) => {
      const port = new FakeJevPort(batchEvaluated(evaluated(probability), evaluated(0.1)));

      const result = await evaluateBuiltIns(makeInput(), { jev: port });

      expect(result.scopeCreep).toEqual({
        ...scopeCreepContext,
        outcome,
        violationProbability: probability,
      });
      expect(port.requests).toHaveLength(1);
    },
  );

  test.each([
    [0, "PASS"],
    [0.499, "PASS"],
    [0.5, "WARN"],
    [0.999, "WARN"],
    [1, "WARN"],
  ] as const)(
    "maps a complexity answer of %s to %s on the fixed advisory gate and never fails",
    async (probability, outcome) => {
      const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(probability)));

      const result = await evaluateBuiltIns(makeInput(), { jev: port });

      expect(result.complexity).toEqual({
        ...complexityContext,
        outcome,
        violationProbability: probability,
      });
      expect(result.complexity.outcome).not.toBe("FAIL");
    },
  );

  test.each([
    [0, "PASS"],
    [0.599, "PASS"],
    [0.6, "WARN"],
    [0.999, "WARN"],
    [1, "WARN"],
  ] as const)(
    "maps a test-adequacy answer of %s to %s on the fixed advisory gate and never fails",
    async (probability, outcome) => {
      const port = new FakeJevPort(
        batchEvaluated(evaluated(0.1), evaluated(0.1), evaluated(probability)),
      );

      const result = await evaluateBuiltIns(makeInput(), { jev: port });

      expect(result.testAdequacy).toEqual({
        ...testAdequacyContext,
        outcome,
        violationProbability: probability,
      });
      expect(result.testAdequacy.outcome).not.toBe("FAIL");
    },
  );

  test("reports every kind, check id, severity, and selected paths", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result.scopeCreep).toMatchObject(scopeCreepContext);
    expect(result.complexity).toMatchObject(complexityContext);
    expect(result.testAdequacy).toMatchObject(testAdequacyContext);
  });
});

describe("built-in batch short-circuits", () => {
  test("skips every check without calling the port when the turn has no attributed patch", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));

    const result = await evaluateBuiltIns(makeInput({ turn: makeTurn({ files: [] }) }), {
      jev: port,
    });

    expect(result).toEqual({
      scopeCreep: {
        ...scopeCreepContext,
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_ATTRIBUTED_PATCH",
      },
      complexity: {
        ...complexityContext,
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_ATTRIBUTED_PATCH",
      },
      testAdequacy: {
        ...testAdequacyContext,
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_ATTRIBUTED_PATCH",
      },
    });
    expect(port.requests).toHaveLength(0);
  });

  test("reports every check blocked without calling the port", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));
    const turn = makeTurn({ files: [file("src/.env", "SECRET=1")] });

    const result = await evaluateBuiltIns(makeInput({ turn }), { jev: port });

    expect(result.scopeCreep).toEqual({
      ...scopeCreepContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
    expect(result.complexity).toEqual({
      ...complexityContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
    expect(result.testAdequacy).toEqual({
      ...testAdequacyContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
    expect(port.requests).toHaveLength(0);
  });

  test("reports every check oversized without calling the port", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));
    const evidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 4 };

    const result = await evaluateBuiltIns(makeInput({ evidencePolicy }), { jev: port });

    expect(result.scopeCreep).toMatchObject({ outcome: "UNAVAILABLE", reason: "OVERSIZED_DIFF" });
    expect(result.complexity).toMatchObject({ outcome: "UNAVAILABLE", reason: "OVERSIZED_DIFF" });
    expect(result.testAdequacy).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(port.requests).toHaveLength(0);
  });
});

describe("built-in batch failures", () => {
  test("maps a request-level typed failure to UNAVAILABLE for every check", async () => {
    const port = new FakeJevPort(batchFailed("MISSING_CREDENTIAL"));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result).toEqual({
      scopeCreep: { ...scopeCreepContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
      complexity: { ...complexityContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
      testAdequacy: { ...testAdequacyContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
    });
    expect(port.requests).toHaveLength(1);
  });

  test("contains a rejected port promise as UNAVAILABLE for every check", async () => {
    const port = new FakeJevPort(new Error("transport down"));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result).toEqual({
      scopeCreep: { ...scopeCreepContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
      complexity: { ...complexityContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
      testAdequacy: { ...testAdequacyContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
    });
    expect(port.requests).toHaveLength(1);
  });

  test("keeps a failed complexity answer from suppressing its valid siblings", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), answerFailed()));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result.scopeCreep).toEqual({
      ...scopeCreepContext,
      outcome: "PASS",
      violationProbability: 0.1,
    });
    expect(result.complexity).toEqual({
      ...complexityContext,
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(result.testAdequacy).toEqual({
      ...testAdequacyContext,
      outcome: "PASS",
      violationProbability: 0.1,
    });
    expect(port.requests).toHaveLength(1);
  });

  test("keeps a failed scope-creep answer from suppressing its valid siblings", async () => {
    const port = new FakeJevPort(batchEvaluated(answerFailed(), evaluated(0.1)));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result.scopeCreep).toEqual({
      ...scopeCreepContext,
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(result.complexity).toEqual({
      ...complexityContext,
      outcome: "PASS",
      violationProbability: 0.1,
    });
    expect(result.testAdequacy).toEqual({
      ...testAdequacyContext,
      outcome: "PASS",
      violationProbability: 0.1,
    });
  });

  test("keeps a failed test-adequacy answer from suppressing its valid siblings", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1), answerFailed()));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result.scopeCreep).toEqual({
      ...scopeCreepContext,
      outcome: "PASS",
      violationProbability: 0.1,
    });
    expect(result.complexity).toEqual({
      ...complexityContext,
      outcome: "PASS",
      violationProbability: 0.1,
    });
    expect(result.testAdequacy).toEqual({
      ...testAdequacyContext,
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(port.requests).toHaveLength(1);
  });

  test.each([1.5, -0.1, Number.NaN])(
    "treats an evaluated out-of-range probability of %s as UNAVAILABLE for that check only",
    async (probability) => {
      const port = new FakeJevPort(batchEvaluated(evaluated(probability), evaluated(0.1)));

      const result = await evaluateBuiltIns(makeInput(), { jev: port });

      expect(result.scopeCreep).toEqual({
        ...scopeCreepContext,
        outcome: "UNAVAILABLE",
        reason: "JEV_FAILURE",
      });
      expect(result.complexity).toEqual({
        ...complexityContext,
        outcome: "PASS",
        violationProbability: 0.1,
      });
      expect(port.requests).toHaveLength(1);
    },
  );

  test("treats an out-of-range test-adequacy probability as UNAVAILABLE for that check only", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1), evaluated(1.5)));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result.testAdequacy).toEqual({
      ...testAdequacyContext,
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(result.scopeCreep).toEqual({
      ...scopeCreepContext,
      outcome: "PASS",
      violationProbability: 0.1,
    });
  });
});
