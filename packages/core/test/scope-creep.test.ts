import { describe, expect, test } from "vitest";
import {
  DEFAULT_EVIDENCE_POLICY,
  SCOPE_CREEP_CHECK_ID,
  buildScopeCreepRequest,
  evaluateScopeCreep,
} from "../src/index";
import type {
  EvaluateScopeCreepInput,
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

function makeInput(overrides: Partial<EvaluateScopeCreepInput> = {}): EvaluateScopeCreepInput {
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
  checkId: SCOPE_CREEP_CHECK_ID,
  severity: "error",
  scopedPaths: ["src/auth/login.ts", "docs/readme.md"],
};

const unavailable = {
  ...selectedContext,
  outcome: "UNAVAILABLE",
  reason: "JEV_FAILURE",
};

describe("scope creep request", () => {
  test("builds exactly one Noul carrying the approved definition and allowed exceptions", () => {
    const request = buildScopeCreepRequest("Add rate limiting.", {
      files: ["src/auth/login.ts", "docs/readme.md"],
      diff: `${LOGIN_PATCH}\n${DOCS_PATCH}`,
    });

    expect(request.kind).toBe("BUILT_IN");
    expect(request.task).toBe("Add rate limiting.");
    expect(request.question.type).toBe("noul");
    expect(request.question.criteria.id).toBe(SCOPE_CREEP_CHECK_ID);
    expect(request.question.criteria.description).toContain("not reasonably necessary");
    expect(request.question.criteria.violation).toContain("did not request");
    expect(request.question.criteria.allowed).toContain("supporting");
    expect(request.question.criteria.allowed).toContain("testing");
    expect(request.question.criteria.allowed).toContain("documentation");
    expect(request.question.criteria.allowed).toContain("immaterial");
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

    await evaluateScopeCreep(makeInput({ turn }), { jev: port });

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

describe("scope creep gate boundaries", () => {
  test.each([
    [0, "PASS"],
    [0.399, "PASS"],
    [0.4, "WARN"],
    [0.699, "WARN"],
    [0.7, "FAIL"],
    [1, "FAIL"],
  ] as const)("maps probability %s to %s on the fixed error gate", async (probability, outcome) => {
    const port = new FakeJevPort(evaluated(probability));

    const result = await evaluateScopeCreep(makeInput(), { jev: port });

    expect(result).toEqual({ ...selectedContext, outcome, violationProbability: probability });
    expect(port.requests).toHaveLength(1);
  });

  test("always uses the fixed error gate regardless of any configured thresholds", async () => {
    const low = await evaluateScopeCreep(makeInput(), { jev: new FakeJevPort(evaluated(0.5)) });
    const high = await evaluateScopeCreep(makeInput(), { jev: new FakeJevPort(evaluated(0.5)) });

    expect(low).toMatchObject({ outcome: "WARN" });
    expect(high).toMatchObject({ outcome: "WARN" });
  });
});

describe("scope creep context", () => {
  test("reports the built-in kind, check id, fixed error severity, and all selected paths", async () => {
    const port = new FakeJevPort(evaluated(0.1));

    const result = await evaluateScopeCreep(makeInput(), { jev: port });

    expect(result).toMatchObject({
      kind: "BUILT_IN",
      turnId: "turn-1",
      ruleId: null,
      checkId: SCOPE_CREEP_CHECK_ID,
      severity: "error",
      scopedPaths: ["src/auth/login.ts", "docs/readme.md"],
    });
  });
});

describe("scope creep short-circuits", () => {
  test("skips without calling the port when the turn has no attributed patch", async () => {
    const port = new FakeJevPort(evaluated(0.1));

    const result = await evaluateScopeCreep(makeInput({ turn: makeTurn({ files: [] }) }), {
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

    const result = await evaluateScopeCreep(makeInput({ turn }), { jev: port });

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

    const result = await evaluateScopeCreep(makeInput({ evidencePolicy }), { jev: port });

    expect(result).toEqual({
      ...selectedContext,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(port.requests).toHaveLength(0);
  });
});

describe("scope creep port failures", () => {
  test("converts a typed failure into UNAVAILABLE without a gate outcome", async () => {
    const port = new FakeJevPort({ status: "FAILED", reason: "MISSING_CREDENTIAL" });

    const result = await evaluateScopeCreep(makeInput(), { jev: port });

    expect(result).toEqual(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test("contains a rejected port promise as UNAVAILABLE instead of throwing", async () => {
    const port = new FakeJevPort(new Error("transport down"));

    await expect(evaluateScopeCreep(makeInput(), { jev: port })).resolves.toEqual(unavailable);
    expect(port.requests).toHaveLength(1);
  });

  test.each([1.5, -0.1, Number.NaN])(
    "treats an evaluated probability of %s as UNAVAILABLE",
    async (probability) => {
      const port = new FakeJevPort(evaluated(probability));

      const result = await evaluateScopeCreep(makeInput(), { jev: port });

      expect(result).toEqual(unavailable);
      expect(port.requests).toHaveLength(1);
    },
  );
});
