import type {
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleEvaluationResult,
  JevRuleRequest,
  PolicyLoader,
  PolicyLoadResult,
  TurnReview,
} from "@jevguard/core";
import { aggregateReview } from "@jevguard/core";
import { parsePolicyConfig, toReviewLogEntry } from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import { parseRulesCheckArguments } from "../src/cli/rules-check/arguments";
import { rulesCheckExitCode } from "../src/cli/rules-check/exit-code";
import { executeRulesCheck, RULES_CHECK_DEFAULT_TASK } from "../src/cli/rules-check/execute";
import {
  describeDiffInputFailure,
  describeRulesCheck,
  serializeRulesCheck,
} from "../src/cli/rules-check/messages";
import type {
  DiffRead,
  DiffReadFailureReason,
  RulesCheckDependencies,
  RulesCheckRequest,
  RulesCheckResult,
} from "../src/cli/rules-check/types";

const TASK_SENTINEL = "TASK-SENTINEL-TEXT";
const SECRET_LINE = "+SECRET_LINE_SENTINEL";

const FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  `${SECRET_LINE}`,
  "",
].join("\n");

describe("parseRulesCheckArguments", () => {
  test("parses every flag", () => {
    expect(
      parseRulesCheckArguments(["--diff", "a.diff", "--task", "do it", "--rule", "R-1", "--json"]),
    ).toEqual({
      request: { diff: { kind: "FILE", path: "a.diff" }, task: "do it", ruleId: "R-1" },
      json: true,
    });
  });

  test("defaults the optional flags", () => {
    expect(parseRulesCheckArguments(["--diff", "a.diff"])).toEqual({
      request: { diff: { kind: "FILE", path: "a.diff" }, task: null, ruleId: null },
      json: false,
    });
  });

  test("treats - as stdin", () => {
    expect(parseRulesCheckArguments(["--diff", "-"])?.request.diff).toEqual({ kind: "STDIN" });
  });

  test("takes a value that starts with a dash", () => {
    expect(parseRulesCheckArguments(["--diff", "-", "--task", "--fix it"])?.request.task).toBe(
      "--fix it",
    );
  });

  test.each([
    ["no arguments", []],
    ["a missing --diff", ["--task", "x"]],
    ["a duplicated flag", ["--diff", "a", "--diff", "b"]],
    ["a duplicated --json", ["--diff", "a", "--json", "--json"]],
    ["an unknown flag", ["--diff", "a", "--bogus"]],
    ["a positional argument", ["--diff", "a", "extra"]],
    ["a flag without a value", ["--diff"]],
    ["an empty value", ["--diff", ""]],
    ["--json given a value", ["--diff", "a", "--json", "true"]],
  ])("returns null for %s", (_name, args) => {
    expect(parseRulesCheckArguments(args)).toBeNull();
  });
});

class FakeJevPort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];

  constructor(private readonly probability = 0.82) {}

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    if (request.kind === "BUILT_IN_BATCH") {
      return { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "API_ERROR" };
    }

    return { kind: "RULE", status: "EVALUATED", noul: { violationProbability: this.probability } };
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

class FakePolicy implements PolicyLoader {
  constructor(private readonly outcome: PolicyLoadResult) {}

  async load(): Promise<PolicyLoadResult> {
    return this.outcome;
  }
}

function rule(id: string, scope = "**"): string {
  return [
    `## ${id}`,
    "",
    "severity: error",
    `scope: ${scope}`,
    "",
    "### Rule",
    "",
    "Module description.",
    "",
    "### Violation",
    "",
    "The change violates the rule.",
  ].join("\n");
}

const REQUEST: RulesCheckRequest = { diff: { kind: "STDIN" }, task: null, ruleId: null };

function dependencies(
  read: DiffRead,
  jev: FakeJevPort,
  rules: string | null = rule("ARCH-001"),
): RulesCheckDependencies {
  return {
    readDiff: async () => read,
    policy: new FakePolicy({ status: "LOADED", source: { rules, config: null } }),
    parseConfig: parsePolicyConfig,
    jev,
  };
}

describe("executeRulesCheck", () => {
  test("sends the provided task to Jev", async () => {
    const jev = new FakeJevPort();

    const result = await executeRulesCheck(
      { ...REQUEST, task: TASK_SENTINEL },
      dependencies({ status: "READ", text: FILE_DIFF }, jev),
    );

    expect(result.status).toBe("REVIEWED");
    expect(jev.requests).toHaveLength(1);
    expect(jev.requests[0]?.task).toBe(TASK_SENTINEL);
  });

  test("uses the default task when none is given", async () => {
    const jev = new FakeJevPort();

    await executeRulesCheck(REQUEST, dependencies({ status: "READ", text: FILE_DIFF }, jev));

    expect(jev.requests[0]?.task).toBe(RULES_CHECK_DEFAULT_TASK);
  });

  test("never calls a built-in request", async () => {
    const jev = new FakeJevPort();

    await executeRulesCheck(REQUEST, dependencies({ status: "READ", text: FILE_DIFF }, jev));

    expect(jev.requests.every((request) => request.kind === "RULE")).toBe(true);
  });

  test.each<DiffReadFailureReason>(["DIFF_READ_FAILURE", "DIFF_TOO_LARGE", "STDIN_IS_TTY"])(
    "maps the read failure %s to INPUT_FAILED without calling Jev",
    async (reason) => {
      const jev = new FakeJevPort();

      const result = await executeRulesCheck(
        REQUEST,
        dependencies({ status: "FAILED", reason }, jev),
      );

      expect(result).toEqual({ status: "INPUT_FAILED", reason });
      expect(jev.requests).toHaveLength(0);
    },
  );

  test("maps an unrecognized diff to INPUT_FAILED without calling Jev", async () => {
    const jev = new FakeJevPort();

    const result = await executeRulesCheck(
      REQUEST,
      dependencies({ status: "READ", text: "garbage\n" }, jev),
    );

    expect(result).toEqual({ status: "INPUT_FAILED", reason: "UNRECOGNIZED_DIFF" });
    expect(jev.requests).toHaveLength(0);
  });

  test("an empty diff skips every rule without calling Jev", async () => {
    const jev = new FakeJevPort();

    const result = await executeRulesCheck(
      REQUEST,
      dependencies({ status: "READ", text: "" }, jev),
    );

    expect(result.status === "REVIEWED" ? result.review.summary.counts.skipped : -1).toBe(1);
    expect(jev.requests).toHaveLength(0);
  });

  test("a .env file in scope is BLOCKED_EVIDENCE without calling Jev", async () => {
    const jev = new FakeJevPort();
    const envDiff = ["--- /dev/null", "+++ b/.env", "@@ -0,0 +1 @@", "+KEY=1", ""].join("\n");

    const result = await executeRulesCheck(
      REQUEST,
      dependencies({ status: "READ", text: envDiff }, jev),
    );

    expect(result.status === "REVIEWED" ? result.review.summary.counts.unavailable : -1).toBe(1);
    expect(
      result.status === "REVIEWED" ? toReviewLogEntry(result.review).results[0] : null,
    ).toMatchObject({ outcome: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" });
    expect(jev.requests).toHaveLength(0);
  });

  test("a rename with content from .env is INPUT_FAILED without calling Jev", async () => {
    const jev = new FakeJevPort();
    const renamed = [
      "diff --git a/.env b/src/env.ts",
      "similarity index 60%",
      "rename from .env",
      "rename to src/env.ts",
      "--- a/.env",
      "+++ b/src/env.ts",
      "@@ -1 +1 @@",
      "-KEY=1",
      "+KEY=2",
      "",
    ].join("\n");

    const result = await executeRulesCheck(
      REQUEST,
      dependencies({ status: "READ", text: renamed }, jev),
    );

    expect(result).toEqual({ status: "INPUT_FAILED", reason: "RENAMED_PATH" });
    expect(jev.requests).toHaveLength(0);
  });

  test("reports an unknown --rule as RULE_NOT_FOUND", async () => {
    const jev = new FakeJevPort();

    const result = await executeRulesCheck(
      { ...REQUEST, ruleId: "NOPE" },
      dependencies({ status: "READ", text: FILE_DIFF }, jev),
    );

    expect(result).toEqual({ status: "RULE_NOT_FOUND" });
    expect(jev.requests).toHaveLength(0);
  });
});

async function reviewOf(
  probability: number,
  rules: string | null = rule("ARCH-001"),
): Promise<TurnReview> {
  const result = await executeRulesCheck(
    { ...REQUEST, task: TASK_SENTINEL },
    dependencies({ status: "READ", text: FILE_DIFF }, new FakeJevPort(probability), rules),
  );

  if (result.status !== "REVIEWED") {
    throw new Error(`expected REVIEWED, got ${result.status}`);
  }

  return result.review;
}

function reviewed(review: TurnReview): RulesCheckResult {
  return { status: "REVIEWED", review };
}

describe("rulesCheckExitCode", () => {
  test.each([
    ["PASS", 0.1, 0],
    ["WARN", 0.5, 0],
    ["FAIL", 0.82, 1],
  ])("exits for a %s verdict", async (_name, probability, expected) => {
    expect(rulesCheckExitCode(reviewed(await reviewOf(probability)))).toBe(expected);
  });

  test("exits 0 when everything is SKIPPED", async () => {
    const result = await executeRulesCheck(
      REQUEST,
      dependencies({ status: "READ", text: "" }, new FakeJevPort()),
    );

    expect(rulesCheckExitCode(result)).toBe(0);
  });

  test("exits 2 for a lone UNAVAILABLE", async () => {
    expect(rulesCheckExitCode(reviewed(await reviewOf(0.1, null)))).toBe(2);
  });

  test("lets FAIL dominate UNAVAILABLE", async () => {
    const failing = await reviewOf(0.9);
    const unavailable = await reviewOf(0.1, null);
    const mixed = aggregateReview("rules-check", [...failing.results, ...unavailable.results]);

    expect(rulesCheckExitCode(reviewed(mixed))).toBe(1);
  });

  test("exits 2 for an unknown rule and for failed input", () => {
    expect(rulesCheckExitCode({ status: "RULE_NOT_FOUND" })).toBe(2);
    expect(rulesCheckExitCode({ status: "INPUT_FAILED", reason: "DIFF_TOO_LARGE" })).toBe(2);
  });
});

describe("rules check messages", () => {
  test("the human form shows the rule, outcome, probability, severity and paths", async () => {
    const output = describeRulesCheck(await reviewOf(0.82));

    expect(output).toContain("ARCH-001");
    expect(output).toContain("FAIL");
    expect(output).toContain("p=0.82");
    expect(output).toContain("error");
    expect(output).toContain("src/a.ts");
    expect(output).toContain("Summary: pass 0 · warn 0 · fail 1 · unavailable 0 · skipped 0");
  });

  test("shows the reason code and a hint for an unavailable result", async () => {
    const output = describeRulesCheck(await reviewOf(0.1, null));

    expect(output).toContain("review");
    expect(output).toContain("INVALID_RULE");
    expect(output).toContain("hint:");
  });

  test("never prints the task or any diff content", async () => {
    const review = await reviewOf(0.82);

    for (const output of [describeRulesCheck(review), serializeRulesCheck(review)]) {
      expect(output).not.toContain(TASK_SENTINEL);
      expect(output).not.toContain("@@");
      expect(output).not.toContain(SECRET_LINE);
      expect(output).not.toContain("SECRET_LINE_SENTINEL");
    }
  });

  test("the JSON form is the versioned log allowlist projection", async () => {
    const review = await reviewOf(0.82);

    expect(JSON.parse(serializeRulesCheck(review))).toEqual({
      version: 1,
      ...JSON.parse(JSON.stringify(toReviewLogEntry(review))),
    });
  });

  test("describes every input failure without echoing input", () => {
    const reasons = [
      "DIFF_READ_FAILURE",
      "DIFF_TOO_LARGE",
      "STDIN_IS_TTY",
      "UNRECOGNIZED_DIFF",
      "BINARY_PATCH",
      "QUOTED_PATH",
      "MISSING_PATH",
      "COMBINED_DIFF",
      "UNSUPPORTED_PREFIX",
      "RENAMED_PATH",
      "TRUNCATED_HUNK",
      "DIFF_NOT_UTF8",
    ] as const;

    for (const reason of reasons) {
      expect(describeDiffInputFailure(reason)).not.toBe("");
    }
  });
});
