import { describe, expect, test } from "vitest";
import {
  DEFAULT_EVIDENCE_POLICY,
  DEFAULT_GATE_CONFIG,
  evaluateRules,
  parseRules,
} from "../src/index";
import type {
  GateConfigResult,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  ParsedRule,
  RuleCandidateResult,
  Turn,
  TurnFile,
} from "../src/index";

class SequencedJevPort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];
  private cursor = 0;

  constructor(private readonly outcomes: readonly (JevEvaluationResult | Error)[]) {}

  evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    const outcome = this.outcomes[this.cursor];
    this.cursor += 1;

    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }

    if (outcome === undefined) {
      return Promise.resolve({ status: "FAILED", reason: "API_ERROR" });
    }

    return Promise.resolve(outcome);
  }
}

function file(path: string, patch: string): TurnFile {
  return { path, patch };
}

function makeTurn(overrides: Partial<Turn> = {}): Turn {
  return {
    id: "turn-1",
    task: "Implement the feature.",
    files: [file("src/a.ts", "src-patch")],
    ...overrides,
  };
}

function makeRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: "R-1",
    severity: "error",
    scope: null,
    description: "A rule.",
    violation: "A violation.",
    allowed: null,
    ...overrides,
  };
}

function parsed(overrides: Partial<ParsedRule> = {}): RuleCandidateResult {
  return { status: "PARSED", rule: makeRule(overrides) };
}

function evaluated(probability: number): JevEvaluationResult {
  return { status: "EVALUATED", noul: { violationProbability: probability } };
}

const validConfig: GateConfigResult = { status: "VALID", config: DEFAULT_GATE_CONFIG };
const invalidConfig: GateConfigResult = { status: "INVALID", reason: "INVALID_CONFIG" };

describe("evaluateRules", () => {
  test("evaluates each rule against its own scope in source order", async () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "src-patch"), file("docs/readme.md", "docs-patch")],
    });
    const rules: readonly RuleCandidateResult[] = [
      parsed({ id: "SRC-1", scope: "src/**" }),
      parsed({ id: "DOCS-1", scope: "docs/**" }),
    ];
    const port = new SequencedJevPort([evaluated(0.1), evaluated(0.9)]);

    const review = await evaluateRules(
      { turn, rules, gateConfig: validConfig, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
      { jev: port },
    );

    expect(review.results.map((result) => result.ruleId)).toEqual(["SRC-1", "DOCS-1"]);
    expect(port.requests.map((request) => request.change.files)).toEqual([
      ["src/a.ts"],
      ["docs/readme.md"],
    ]);
    expect(review.summary.counts).toEqual({
      pass: 1,
      warn: 0,
      fail: 1,
      skipped: 0,
      unavailable: 0,
    });
    expect(review.summary.verdict).toBe("FAIL");
  });

  test("keeps a scope miss independent from evaluated siblings", async () => {
    const turn = makeTurn({ files: [file("src/a.ts", "src-patch")] });
    const rules: readonly RuleCandidateResult[] = [
      parsed({ id: "SRC-1", scope: "src/**" }),
      parsed({ id: "DOCS-1", scope: "docs/**" }),
    ];
    const port = new SequencedJevPort([evaluated(0.1)]);

    const review = await evaluateRules(
      { turn, rules, gateConfig: validConfig, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
      { jev: port },
    );

    expect(review.results[0]).toMatchObject({ ruleId: "SRC-1", outcome: "PASS" });
    expect(review.results[1]).toEqual({
      kind: "RULE",
      turnId: "turn-1",
      ruleId: "DOCS-1",
      severity: "error",
      scopedPaths: [],
      outcome: "SKIPPED",
      reason: "NO_SCOPE_MATCH",
    });
    expect(port.requests).toHaveLength(1);
    expect(review.summary.counts).toEqual({
      pass: 1,
      warn: 0,
      fail: 0,
      skipped: 1,
      unavailable: 0,
    });
  });

  test("keeps blocked evidence independent from valid siblings", async () => {
    const turn = makeTurn({
      files: [file("src/.env", "SECRET=1"), file("docs/readme.md", "docs-patch")],
    });
    const rules: readonly RuleCandidateResult[] = [
      parsed({ id: "SRC-1", scope: "src/**" }),
      parsed({ id: "DOCS-1", scope: "docs/**" }),
    ];
    const port = new SequencedJevPort([evaluated(0.1)]);

    const review = await evaluateRules(
      { turn, rules, gateConfig: validConfig, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
      { jev: port },
    );

    expect(review.results[0]).toEqual({
      kind: "RULE",
      turnId: "turn-1",
      ruleId: "SRC-1",
      severity: "error",
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
    expect(review.results[1]).toMatchObject({ ruleId: "DOCS-1", outcome: "PASS" });
    expect(port.requests.map((request) => request.change.files)).toEqual([["docs/readme.md"]]);
  });

  test("keeps oversized evidence independent from smaller siblings", async () => {
    const turn = makeTurn({
      files: [file("src/a.ts", "x".repeat(64)), file("docs/readme.md", "short")],
    });
    const rules: readonly RuleCandidateResult[] = [
      parsed({ id: "SRC-1", scope: "src/**" }),
      parsed({ id: "DOCS-1", scope: "docs/**" }),
    ];
    const port = new SequencedJevPort([evaluated(0.1)]);
    const evidencePolicy = { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength: 16 };

    const review = await evaluateRules(
      { turn, rules, gateConfig: validConfig, evidencePolicy },
      { jev: port },
    );

    expect(review.results[0]).toMatchObject({
      ruleId: "SRC-1",
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(review.results[1]).toMatchObject({ ruleId: "DOCS-1", outcome: "PASS" });
    expect(port.requests).toHaveLength(1);
  });

  test("reports a parse failure per rule and still evaluates valid siblings", async () => {
    const rules = parseRules(
      [
        "## A-1",
        "### Rule",
        "A rule.",
        "### Violation",
        "A violation.",
        "## B-2",
        "severity: error",
        "### Rule",
        "B rule.",
        "### Violation",
        "B violation.",
      ].join("\n"),
    );
    const port = new SequencedJevPort([evaluated(0.1)]);

    const review = await evaluateRules(
      { turn: makeTurn(), rules, gateConfig: validConfig, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
      { jev: port },
    );

    expect(review.results[0]).toEqual({
      kind: "RULE",
      turnId: "turn-1",
      ruleId: "A-1",
      severity: null,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "INVALID_RULE",
    });
    expect(review.results[1]).toMatchObject({ ruleId: "B-2", outcome: "PASS" });
    expect(port.requests).toHaveLength(1);
    expect(review.summary.counts).toEqual({
      pass: 1,
      warn: 0,
      fail: 0,
      skipped: 0,
      unavailable: 1,
    });
  });

  test("applies an invalid configuration to every parsed rule without a Jev call", async () => {
    const rules: readonly RuleCandidateResult[] = [
      parsed({ id: "R-1", severity: "warning" }),
      parsed({ id: "R-2" }),
    ];
    const port = new SequencedJevPort([evaluated(0.1)]);

    const review = await evaluateRules(
      {
        turn: makeTurn(),
        rules,
        gateConfig: invalidConfig,
        evidencePolicy: DEFAULT_EVIDENCE_POLICY,
      },
      { jev: port },
    );

    expect(review.results[0]).toEqual({
      kind: "RULE",
      turnId: "turn-1",
      ruleId: "R-1",
      severity: "warning",
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "INVALID_CONFIG",
    });
    expect(review.results[1]).toEqual({
      kind: "RULE",
      turnId: "turn-1",
      ruleId: "R-2",
      severity: "error",
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "INVALID_CONFIG",
    });
    expect(port.requests).toHaveLength(0);
    expect(review.summary.verdict).toBeNull();
    expect(review.summary.hasUnavailable).toBe(true);
  });

  test("continues after a typed Jev failure", async () => {
    const rules: readonly RuleCandidateResult[] = [parsed({ id: "R-1" }), parsed({ id: "R-2" })];
    const port = new SequencedJevPort([
      { status: "FAILED", reason: "MISSING_CREDENTIAL" },
      evaluated(0.1),
    ]);

    const review = await evaluateRules(
      { turn: makeTurn(), rules, gateConfig: validConfig, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
      { jev: port },
    );

    expect(review.results[0]).toMatchObject({
      ruleId: "R-1",
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(review.results[1]).toMatchObject({ ruleId: "R-2", outcome: "PASS" });
    expect(port.requests).toHaveLength(2);
    expect(review.summary.verdict).toBe("PASS");
    expect(review.summary.hasUnavailable).toBe(true);
  });

  test("continues after a rejected Jev call", async () => {
    const rules: readonly RuleCandidateResult[] = [parsed({ id: "R-1" }), parsed({ id: "R-2" })];
    const port = new SequencedJevPort([new Error("transport down"), evaluated(0.1)]);

    const review = await evaluateRules(
      { turn: makeTurn(), rules, gateConfig: validConfig, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
      { jev: port },
    );

    expect(review.results[0]).toMatchObject({
      ruleId: "R-1",
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(review.results[1]).toMatchObject({ ruleId: "R-2", outcome: "PASS" });
    expect(port.requests).toHaveLength(2);
  });
});
