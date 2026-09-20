import { describe, expect, test } from "vitest";
import {
  COMPLEXITY_CHECK_ID,
  DEFAULT_EVIDENCE_POLICY,
  buildComplexityRequest,
  evaluateComplexity,
} from "../src/index";
import type {
  EvaluateComplexityInput,
  JevBuiltInRequest,
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

function makeInput(overrides: Partial<EvaluateComplexityInput> = {}): EvaluateComplexityInput {
  return {
    turn: makeTurn(),
    evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    ...overrides,
  };
}

function evaluated(probability: number): JevEvaluationResult {
  return { status: "EVALUATED", noul: { violationProbability: probability } };
}

function firstRequest(port: FakeJevPort): JevBuiltInRequest {
  const [request] = port.requests;

  if (request === undefined || !("kind" in request)) {
    throw new Error("expected a built-in request");
  }

  return request;
}

const selectedContext = {
  kind: "BUILT_IN",
  turnId: "turn-1",
  ruleId: null,
  checkId: COMPLEXITY_CHECK_ID,
  severity: "warning",
  scopedPaths: ["src/auth/login.ts", "docs/readme.md"],
};

const unavailable = {
  ...selectedContext,
  outcome: "UNAVAILABLE",
  reason: "JEV_FAILURE",
};

describe("complexity request", () => {
  test("builds exactly one Noul carrying the approved definition and allowed exceptions", () => {
    const request = buildComplexityRequest("Add rate limiting.", {
      files: ["src/auth/login.ts", "docs/readme.md"],
      diff: `${LOGIN_PATCH}\n${DOCS_PATCH}`,
    });

    expect(request.kind).toBe("BUILT_IN");
    expect(request.task).toBe("Add rate limiting.");
    expect(request.question.type).toBe("noul");
    expect(request.question.criteria.id).toBe(COMPLEXITY_CHECK_ID);
    expect(request.question.instructions).toContain("not reasonably necessary");
    expect(request.question.instructions).toContain("explicitly required by the task");
    expect(request.question.criteria.description).toContain("disproportionate");
    expect(request.question.criteria.violation).toContain("premature generalization");
    expect(request.question.criteria.violation).toContain("dependencies");
    expect(request.question.criteria.allowed).toContain("explicitly required by the task");
    expect(request.question.criteria.allowed).toContain("tests");
    expect(request.question.criteria.allowed).toContain("error handling");
    expect(request.change).toEqual({
      files: ["src/auth/login.ts", "docs/readme.md"],
      diff: `${LOGIN_PATCH}\n${DOCS_PATCH}`,
    });
  });

  test("sends every attributed path and the task to Jev without scope filtering", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const turn = makeTurn({
      files: [
        file("src/auth/login.ts", LOGIN_PATCH),
        file("docs/readme.md", DOCS_PATCH),
        file("config/app.yaml", CONFIG_PATCH),
      ],
    });

    await evaluateComplexity(makeInput({ turn }), { jev: port });

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
});

describe("complexity advisory gate boundaries", () => {
  test.each([
    [0, "PASS"],
    [0.499, "PASS"],
    [0.5, "WARN"],
    [0.999, "WARN"],
    [1, "WARN"],
  ] as const)(
    "maps probability %s to %s on the fixed advisory gate and never fails",
    async (probability, outcome) => {
      const port = new FakeJevPort(evaluated(probability));

      const result = await evaluateComplexity(makeInput(), { jev: port });

      expect(result).toEqual({ ...selectedContext, outcome, violationProbability: probability });
      expect(result.outcome).not.toBe("FAIL");
      expect(port.requests).toHaveLength(1);
    },
  );
});

describe("complexity context", () => {
  test("reports the built-in kind, check id, advisory severity, and all selected paths", async () => {
    const port = new FakeJevPort(evaluated(0.1));

    const result = await evaluateComplexity(makeInput(), { jev: port });

    expect(result).toMatchObject({
      kind: "BUILT_IN",
      turnId: "turn-1",
      ruleId: null,
      checkId: COMPLEXITY_CHECK_ID,
      severity: "warning",
      scopedPaths: ["src/auth/login.ts", "docs/readme.md"],
    });
  });
});

describe("complexity short-circuits", () => {
  test("skips without calling the port when the turn has no attributed patch", async () => {
    const port = new FakeJevPort(evaluated(0.1));

    const result = await evaluateComplexity(makeInput({ turn: makeTurn({ files: [] }) }), {
      jev: port,
    });

    expect(result).toEqual({
      ...selectedContext,
      scopedPaths: [],
      outcome: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
    expect(port.requests).toHaveLength(0);
  });

  test("reports blocked evidence without calling the port", async () => {
    const port = new FakeJevPort(evaluated(0.1));
    const turn = makeTurn({ files: [file("src/.env", "SECRET=1")] });

    const result = await evaluateComplexity(makeInput({ turn }), { jev: port });

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

    const result = await evaluateComplexity(makeInput({ evidencePolicy }), { jev: port });

    expect(result).toEqual({
      ...selectedContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(port.requests).toHaveLength(0);
  });
});

describe("complexity port failures", () => {
  test("converts a typed failure into UNAVAILABLE without a gate outcome", async () => {
    const port = new FakeJevPort({ status: "FAILED", reason: "MISSING_CREDENTIAL" });

    const result = await evaluateComplexity(makeInput(), { jev: port });

    expect(result).toEqual(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test("contains a rejected port promise as UNAVAILABLE instead of throwing", async () => {
    const port = new FakeJevPort(new Error("transport down"));

    await expect(evaluateComplexity(makeInput(), { jev: port })).resolves.toEqual(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test.each([1.5, -0.1, Number.NaN])(
    "treats an evaluated probability of %s as UNAVAILABLE",
    async (probability) => {
      const port = new FakeJevPort(evaluated(probability));

      const result = await evaluateComplexity(makeInput(), { jev: port });

      expect(result).toEqual(unavailable);
      expect(port.requests).toHaveLength(1);
    },
  );
});
