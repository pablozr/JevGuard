import { describe, expect, test } from "vitest";
import { DEFAULT_EVIDENCE_POLICY, DEFAULT_GATE_CONFIG, evaluateRules } from "../src/index";
import type {
  EvidencePolicy,
  GateConfigResult,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRuleEvaluationResult,
  JevRuleRequest,
  ParsedRule,
  RuleCandidateResult,
  RuleReviewResult,
  Turn,
  TurnFile,
} from "../src/index";

const validConfig: GateConfigResult = { status: "VALID", config: DEFAULT_GATE_CONFIG };

function file(path: string, patch: string): TurnFile {
  return { path, patch };
}

function makeRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: "R-1",
    severity: "error",
    scope: null,
    evidence: "code",
    description: "A rule.",
    violation: "A violation.",
    allowed: null,
    ...overrides,
  };
}

function parsed(overrides: Partial<ParsedRule> = {}): RuleCandidateResult {
  return { status: "PARSED", rule: makeRule(overrides) };
}

function evaluated(probability: number): JevRuleEvaluationResult {
  return { kind: "RULE", status: "EVALUATED", noul: { violationProbability: probability } };
}

function failed(): JevRuleEvaluationResult {
  return { kind: "RULE", status: "FAILED", reason: "API_ERROR" };
}

class BatchPort implements JevEvaluationPort {
  readonly requests: JevRuleRequest[] = [];
  readonly batchSizes: number[] = [];

  constructor(private readonly results: readonly JevRuleEvaluationResult[]) {}

  evaluate(): Promise<JevEvaluationResult> {
    return Promise.resolve({ kind: "RULE", status: "FAILED", reason: "API_ERROR" });
  }

  evaluateRuleBatch(
    requests: readonly JevRuleRequest[],
  ): Promise<readonly JevRuleEvaluationResult[]> {
    this.batchSizes.push(requests.length);
    this.requests.push(...requests);

    return Promise.resolve(this.results);
  }
}

const slicePolicy: EvidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 12 };

function slicingTurn(count: number): Turn {
  return {
    id: "turn-1",
    task: "task",
    files: Array.from({ length: count }, (_unused, index) =>
      file(`src/f${index}.ts`, `patch-${String(index).padStart(5, "0")}`),
    ),
  };
}

interface RunResult {
  readonly result: RuleReviewResult;
  readonly port: BatchPort;
}

async function run(
  results: readonly JevRuleEvaluationResult[],
  options: { readonly rule?: Partial<ParsedRule>; readonly files?: number } = {},
): Promise<RunResult> {
  const port = new BatchPort(results);
  const review = await evaluateRules(
    {
      turn: slicingTurn(options.files ?? results.length),
      rules: [parsed(options.rule ?? {})],
      gateConfig: validConfig,
      evidencePolicy: slicePolicy,
    },
    { jev: port },
  );

  const result = review.results[0];

  if (result === undefined || result.kind !== "RULE") {
    throw new Error("expected a rule result");
  }

  return { result, port };
}

describe("evaluateRules sliced aggregation", () => {
  test("all slices PASS when every probability is below the warning threshold", async () => {
    const { result, port } = await run([evaluated(0.1), evaluated(0.2)]);

    expect(result).toMatchObject({
      outcome: "PASS",
      violationProbability: 0.2,
      evidence: {
        mode: "SLICED",
        plannedSliceCount: 2,
        evaluatedSliceCount: 2,
        failedSliceCount: 0,
        notEvaluatedSliceCount: 0,
        failingSliceIndex: null,
        failureReason: null,
      },
    });
    expect(result.evidence?.sliceJudgments).toEqual([
      { index: 0, probability: 0.1, outcome: "PASS" },
      { index: 1, probability: 0.2, outcome: "PASS" },
    ]);
    expect(port.batchSizes).toEqual([2]);
  });

  test("repeats the task and the one rule Noul, with Allowed, for every slice", async () => {
    const allowed = "Validation and HTTP mapping.";
    const { port } = await run([evaluated(0.1), evaluated(0.2)], {
      rule: { id: "ARCH-001", allowed },
    });

    expect(port.requests).toHaveLength(2);
    expect(port.requests.every((request) => request.task === "task")).toBe(true);
    expect(port.requests.map((request) => request.question.criteria.id)).toEqual([
      "ARCH-001",
      "ARCH-001",
    ]);
    expect(port.requests.every((request) => request.question.criteria.allowed === allowed)).toBe(
      true,
    );
    expect(port.requests[0]?.change.diff).not.toBe(port.requests[1]?.change.diff);
  });

  test("any slice WARN makes the rule WARN", async () => {
    const { result } = await run([evaluated(0.1), evaluated(0.5)]);

    expect(result).toMatchObject({ outcome: "WARN", violationProbability: 0.5 });
  });

  test("any slice FAIL makes the rule FAIL", async () => {
    const { result } = await run([evaluated(0.1), evaluated(0.8)]);

    expect(result).toMatchObject({ outcome: "FAIL", violationProbability: 0.8 });
  });

  test("retains the maximum probability across slices", async () => {
    const { result } = await run([evaluated(0.45), evaluated(0.6), evaluated(0.5)]);

    expect(result).toMatchObject({ outcome: "WARN", violationProbability: 0.6 });
  });

  test("a warning rule never fails", async () => {
    const { result } = await run([evaluated(0.95), evaluated(0.99)], {
      rule: { severity: "warning" },
    });

    expect(result.outcome).toBe("WARN");
    expect(result).toMatchObject({ violationProbability: 0.99 });
  });
});

describe("evaluateRules sliced operational results", () => {
  test("any slice failure makes the rule UNAVAILABLE without sibling probabilities", async () => {
    const { result } = await run([evaluated(0.1), failed()]);

    expect(result).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
      evidence: {
        mode: "SLICED",
        plannedSliceCount: 2,
        evaluatedSliceCount: 1,
        failedSliceCount: 1,
        notEvaluatedSliceCount: 0,
        failingSliceIndex: 1,
        sliceJudgments: [],
        failureReason: "JEV_FAILURE",
      },
    });
    expect("violationProbability" in result).toBe(false);
  });

  test("never invents PASS from an out-of-range slice probability", async () => {
    const { result } = await run([
      { kind: "RULE", status: "EVALUATED", noul: { violationProbability: 1.5 } },
      evaluated(0.1),
    ]);

    expect(result).toMatchObject({ outcome: "UNAVAILABLE", reason: "JEV_FAILURE" });
    expect("violationProbability" in result).toBe(false);
  });

  test("reports SLICE_LIMIT_EXCEEDED without a Jev call when a rule exceeds the slice cap", async () => {
    const port = new BatchPort([evaluated(0.1)]);
    const review = await evaluateRules(
      {
        turn: slicingTurn(17),
        rules: [parsed()],
        gateConfig: validConfig,
        evidencePolicy: slicePolicy,
      },
      { jev: port },
    );

    expect(review.results[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "SLICE_LIMIT_EXCEEDED",
      evidence: {
        mode: "SLICED",
        plannedSliceCount: 17,
        evaluatedSliceCount: 0,
        failedSliceCount: 0,
        notEvaluatedSliceCount: 17,
        failingSliceIndex: null,
        failureReason: "SLICE_LIMIT_EXCEEDED",
      },
    });
    expect(port.batchSizes).toEqual([]);
  });
});

describe("evaluateRules whole fast path", () => {
  test("issues exactly one call for a fitting rule", async () => {
    const port = new BatchPort([evaluated(0.1)]);
    const review = await evaluateRules(
      {
        turn: { id: "turn-1", task: "task", files: [file("src/a.ts", "patch-a")] },
        rules: [parsed()],
        gateConfig: validConfig,
        evidencePolicy: DEFAULT_EVIDENCE_POLICY,
      },
      { jev: port },
    );

    expect(port.batchSizes).toEqual([1]);
    expect(port.requests).toHaveLength(1);
    expect(review.results[0]).toMatchObject({
      outcome: "PASS",
      evidence: { mode: "WHOLE", plannedSliceCount: 1, evaluatedSliceCount: 1 },
    });
  });
});
