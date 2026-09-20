import { describe, expect, test } from "vitest";
import {
  COMPLEXITY_CHECK_ID,
  DEFAULT_EVIDENCE_POLICY,
  SCOPE_CREEP_CHECK_ID,
  buildBuiltInBatchRequest,
  evaluateBuiltIns,
} from "../src/index";
import type {
  EvaluateBuiltInsInput,
  JevBuiltInAnswerResult,
  JevBuiltInBatchRequest,
  JevBuiltInBatchResult,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  Turn,
  TurnFile,
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
): JevBuiltInBatchResult {
  return { kind: "BUILT_IN_BATCH", status: "EVALUATED", answers: { scopeCreep, complexity } };
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

describe("built-in batch request", () => {
  test("builds one request with both named Nouls, the task, and the complete change", () => {
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

  test("selects evidence once and issues exactly one request for both checks", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(port.requests).toHaveLength(1);
    expect(result).toEqual({
      scopeCreep: { ...scopeCreepContext, outcome: "PASS", violationProbability: 0.1 },
      complexity: { ...complexityContext, outcome: "PASS", violationProbability: 0.1 },
    });
  });

  test.each([
    [0, "PASS"],
    [0.399, "PASS"],
    [0.4, "WARN"],
    [0.699, "WARN"],
    [0.7, "FAIL"],
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

  test("reports both kinds, check ids, severities, and selected paths", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result.scopeCreep).toMatchObject(scopeCreepContext);
    expect(result.complexity).toMatchObject(complexityContext);
  });
});

describe("built-in batch short-circuits", () => {
  test("skips both checks without calling the port when the turn has no attributed patch", async () => {
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
    });
    expect(port.requests).toHaveLength(0);
  });

  test("reports both checks blocked without calling the port", async () => {
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
    expect(port.requests).toHaveLength(0);
  });

  test("reports both checks oversized without calling the port", async () => {
    const port = new FakeJevPort(batchEvaluated(evaluated(0.1), evaluated(0.1)));
    const evidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 4 };

    const result = await evaluateBuiltIns(makeInput({ evidencePolicy }), { jev: port });

    expect(result.scopeCreep).toMatchObject({ outcome: "UNAVAILABLE", reason: "OVERSIZED_DIFF" });
    expect(result.complexity).toMatchObject({ outcome: "UNAVAILABLE", reason: "OVERSIZED_DIFF" });
    expect(port.requests).toHaveLength(0);
  });
});

describe("built-in batch failures", () => {
  test("maps a request-level typed failure to UNAVAILABLE for both checks", async () => {
    const port = new FakeJevPort(batchFailed("MISSING_CREDENTIAL"));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result).toEqual({
      scopeCreep: { ...scopeCreepContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
      complexity: { ...complexityContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
    });
    expect(port.requests).toHaveLength(1);
  });

  test("contains a rejected port promise as UNAVAILABLE for both checks", async () => {
    const port = new FakeJevPort(new Error("transport down"));

    const result = await evaluateBuiltIns(makeInput(), { jev: port });

    expect(result).toEqual({
      scopeCreep: { ...scopeCreepContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
      complexity: { ...complexityContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
    });
    expect(port.requests).toHaveLength(1);
  });

  test("keeps a failed complexity answer from suppressing a valid scope-creep answer", async () => {
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
    expect(port.requests).toHaveLength(1);
  });

  test("keeps a failed scope-creep answer from suppressing a valid complexity answer", async () => {
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
});
