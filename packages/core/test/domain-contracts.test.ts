import { describe, expect, test } from "vitest";
import type {
  GateConfig,
  JevRequest,
  ParsedRule,
  ReviewOutcome,
  ReviewResult,
  RuleEvidence,
  Turn,
} from "../src/index";

const loginPatch = "diff --git a/src/auth/login.ts b/src/auth/login.ts\n+const limit = 5;";

const turn: Turn = {
  id: "msg_assistant_1",
  task: "Add rate limiting to the login endpoint.",
  files: [{ path: "src/auth/login.ts", patch: loginPatch }],
};

const rule: ParsedRule = {
  id: "ARCH-001",
  severity: "error",
  scope: "src/**",
  description: "HTTP controllers must not contain business logic.",
  violation: "A controller performs domain decisions, calculations, or state mutations directly.",
  allowed: "Validation, HTTP mapping and delegation to services.",
};

const evidence: RuleEvidence = {
  files: turn.files.map((file) => file.path),
  diff: loginPatch,
};

const gateConfig: GateConfig = {
  version: 1,
  thresholds: {
    error: { warn: 0.4, fail: 0.7 },
    warning: { warn: 0.6 },
  },
};

const reviewContext = {
  turnId: turn.id,
  ruleId: rule.id,
  severity: rule.severity,
  scopedPaths: evidence.files,
};

function assertNever(value: never): never {
  throw new Error(`Unhandled review outcome: ${String(value)}`);
}

function describeOutcome(result: ReviewResult): string {
  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return `${result.outcome}:${result.violationProbability}`;
    case "SKIPPED":
      return `SKIPPED:${result.reason}`;
    case "UNAVAILABLE":
      return `UNAVAILABLE:${result.reason}`;
    default:
      return assertNever(result);
  }
}

describe("core domain contracts", () => {
  test("constructs a representative evaluated turn", () => {
    expect(turn.files).toEqual([{ path: "src/auth/login.ts", patch: loginPatch }]);
    expect(turn.task).toBe("Add rate limiting to the login endpoint.");
    expect(turn.files[0]?.patch).toContain("diff --git");
  });

  test("constructs a rule whose allowed section stays in the same judgment", () => {
    expect(rule.severity).toBe("error");
    expect(rule.scope).toBe("src/**");
    expect(rule.allowed).toContain("delegation");
  });

  test("constructs default gate configuration in probability space", () => {
    expect(gateConfig.version).toBe(1);
    expect(gateConfig.thresholds.error).toEqual({ warn: 0.4, fail: 0.7 });
    expect(gateConfig.thresholds.warning).toEqual({ warn: 0.6 });
  });

  test("rejects arbitrary gate configuration versions at compile time", () => {
    // @ts-expect-error V0.1 accepts only version 1.
    const unsupported: GateConfig = { version: 2, thresholds: gateConfig.thresholds };

    void unsupported;
  });

  test("maps every review outcome exhaustively and keeps operational states distinct", () => {
    const results: readonly ReviewResult[] = [
      { ...reviewContext, outcome: "PASS", violationProbability: 0.1 },
      { ...reviewContext, outcome: "WARN", violationProbability: 0.5 },
      { ...reviewContext, outcome: "FAIL", violationProbability: 0.9 },
      { ...reviewContext, outcome: "SKIPPED", reason: "NO_SCOPE_MATCH" },
      { ...reviewContext, outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
    ];

    expect(results.map(describeOutcome)).toEqual([
      "PASS:0.1",
      "WARN:0.5",
      "FAIL:0.9",
      "SKIPPED:NO_SCOPE_MATCH",
      "UNAVAILABLE:JEV_FAILURE",
    ]);
  });

  test("keeps semantic verdicts disjoint from operational statuses", () => {
    const verdicts: readonly ReviewOutcome[] = ["PASS", "WARN", "FAIL"];
    const operational: readonly ReviewOutcome[] = ["SKIPPED", "UNAVAILABLE"];

    expect(verdicts.filter((outcome) => operational.includes(outcome))).toEqual([]);
  });

  test("builds one Jev request per rule with allowed inside the same criteria", () => {
    const request: JevRequest = {
      task: turn.task,
      rule: {
        id: rule.id,
        description: rule.description,
        violation: rule.violation,
        ...(rule.allowed === null ? {} : { allowed: rule.allowed }),
      },
      change: { files: evidence.files, diff: evidence.diff },
    };

    expect(request.rule.allowed).toBe(rule.allowed);
    expect("allowed" in request.rule).toBe(true);
    expect(request.change.diff).toBe(evidence.diff);
  });
});
