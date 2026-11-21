import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  aggregateReview,
  type JevEvaluationPort,
  type JevEvaluationResult,
  type JevRequest,
  type JevRuleEvaluationResult,
  type JevRuleRequest,
  type PolicyLoadResult,
  type PolicyLoader,
} from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/node-infra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { parseCheckArguments } from "../src/check/arguments";
import { executeCheck } from "../src/check/execute";
import { createGitRangeReader } from "../src/check/git";
import { describeCheck, describeCheckAnnotations, serializeCheck } from "../src/check/messages";
import type {
  CheckDependencies,
  CheckResult,
  CheckVerdict,
  RangeReadOptions,
} from "../src/check/types";
import { checkExitCode, evaluateCheck } from "../src/check/verdict";
import type { ReplayedCommit, ReplayCommitResult } from "../src/replay/types";

const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

const SUBJECT_SENTINEL = "SUBJECT_SENTINEL_DO_NOT_PRINT";
const DIFF_SENTINEL = "DIFF_SENTINEL_DO_NOT_PRINT";
const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

describe("parseCheckArguments", () => {
  test("parses a range with every flag", () => {
    expect(
      parseCheckArguments([
        "--range",
        "origin/main..HEAD",
        "--last",
        "3",
        "--rule",
        "SECRETS-001",
        "--strict",
        "--json",
      ]),
    ).toEqual({
      kind: "RUN",
      request: { range: "origin/main..HEAD", last: 3, ruleId: "SECRETS-001", strict: true },
      output: "JSON",
    });
  });

  test("defaults to the whole range at the cap, every rule, text output", () => {
    expect(parseCheckArguments(["--range", "main..HEAD"])).toEqual({
      kind: "RUN",
      request: { range: "main..HEAD", last: null, ruleId: null, strict: false },
      output: "TEXT",
    });
  });

  test("accepts revision suffixes and the upstream shorthand", () => {
    for (const range of ["HEAD~2..HEAD", "@{upstream}..HEAD", "v0.4.1..main", "abc1234..def5678"]) {
      expect(parseCheckArguments(["--range", range])?.kind).toBe("RUN");
    }
  });

  test("selects annotations output", () => {
    const parsed = parseCheckArguments(["--range", "main..HEAD", "--annotations"]);

    expect(parsed).toMatchObject({ kind: "RUN", output: "ANNOTATIONS" });
  });

  test("refuses --staged as out of v1", () => {
    expect(parseCheckArguments(["--staged"])).toEqual({ kind: "STAGED_OUT_OF_V1" });
  });

  test.each([
    ["a triple dot", ["--range", "main...HEAD"]],
    ["two separators", ["--range", "a..b..c"]],
    ["an empty side", ["--range", "..HEAD"]],
    ["a flag as the range", ["--range", "--force"]],
    ["a range with a space", ["--range", "main..HEAD --force"]],
    ["a missing range", ["--last", "3"]],
    ["a zero last", ["--range", "a..b", "--last", "0"]],
    ["a last above the cap", ["--range", "a..b", "--last", "51"]],
    ["json with annotations", ["--range", "a..b", "--json", "--annotations"]],
    ["staged with a range", ["--range", "a..b", "--staged"]],
    ["an unknown flag", ["--range", "a..b", "--since", "1w"]],
    ["a duplicated flag", ["--range", "a..b", "--range", "c..d"]],
  ])("refuses %s", (_name, args) => {
    expect(parseCheckArguments(args)).toBeNull();
  });
});

class FakeJevPort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];

  constructor(private readonly outcome: "PASS" | "FAIL" | "UNAVAILABLE" = "FAIL") {}

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    if (request.kind === "BUILT_IN_BATCH") {
      return { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "API_ERROR" };
    }

    if (this.outcome === "UNAVAILABLE") {
      return { kind: "RULE", status: "FAILED", reason: "API_ERROR" };
    }

    return {
      kind: "RULE",
      status: "EVALUATED",
      noul: { violationProbability: this.outcome === "FAIL" ? 0.82 : 0.1 },
    };
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

function rule(id: string, severity = "error"): string {
  return [
    `## ${id}`,
    "",
    `severity: ${severity}`,
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

function commit(sha: string, overrides: Partial<ReplayedCommit> = {}): ReplayedCommit {
  return { sha, subject: SUBJECT_SENTINEL, diff: DIFF, merge: false, ...overrides };
}

function dependencies(
  commits: readonly ReplayedCommit[],
  jev = new FakeJevPort(),
  rules = rule("ARCH-001"),
): CheckDependencies {
  return {
    readRange: async () => ({ status: "READ", commits }),
    policy: new FakePolicy({ status: "LOADED", source: { rules, config: null } }),
    parseConfig: parsePolicyConfig,
    jev,
  };
}

function checked(commits: readonly ReplayCommitResult[]): CheckResult {
  return { status: "CHECKED", commits };
}

function ruleResult(
  outcome: "PASS" | "WARN" | "FAIL",
  severity: "error" | "warning" = "error",
): ReplayCommitResult {
  return {
    sha: SHA,
    status: "REVIEWED",
    review: aggregateReview("rules-check", [
      {
        kind: "RULE",
        turnId: "rules-check",
        ruleId: "ARCH-001",
        severity,
        scopedPaths: [],
        outcome,
        violationProbability: 0.82,
      },
    ]),
  };
}

describe("executeCheck", () => {
  test("reads the range at the cap and reviews each commit's subject as the task", async () => {
    const jev = new FakeJevPort("PASS");
    const calls: { range: string; options: RangeReadOptions }[] = [];

    const result = await executeCheck(
      { range: "main..HEAD", last: null, ruleId: null, strict: false },
      {
        ...dependencies([commit("a".repeat(40)), commit("b".repeat(40))], jev),
        readRange: async (range, options) => {
          calls.push({ range, options });

          return { status: "READ", commits: [commit("a".repeat(40)), commit("b".repeat(40))] };
        },
      },
    );

    expect(result.status).toBe("CHECKED");
    expect(calls).toEqual([{ range: "main..HEAD", options: { newest: null, cap: 50 } }]);
    expect(jev.requests.map((request) => request.task)).toEqual([
      SUBJECT_SENTINEL,
      SUBJECT_SENTINEL,
    ]);
  });

  test("passes the explicit --last slice and the rule filter through", async () => {
    const options: RangeReadOptions[] = [];
    const jev = new FakeJevPort("PASS");

    await executeCheck(
      { range: "main..HEAD", last: 2, ruleId: "ARCH-001", strict: false },
      {
        ...dependencies([commit("a".repeat(40))], jev),
        readRange: async (_range, readOptions) => {
          options.push(readOptions);

          return { status: "READ", commits: [commit("a".repeat(40))] };
        },
      },
    );

    expect(options).toEqual([{ newest: 2, cap: 50 }]);
    expect(jev.requests).toHaveLength(1);
  });

  test("never calls Jev when the range cannot be read", async () => {
    const jev = new FakeJevPort();

    const result = await executeCheck(
      { range: "main..HEAD", last: null, ruleId: null, strict: false },
      {
        ...dependencies([], jev),
        readRange: async () => ({ status: "FAILED", reason: "RANGE_INVALID" }),
      },
    );

    expect(result).toEqual({ status: "FAILED", reason: "RANGE_INVALID" });
    expect(jev.requests).toEqual([]);
  });

  test("passes a range above the cap through without reviewing it", async () => {
    const jev = new FakeJevPort();

    const result = await executeCheck(
      { range: "main..HEAD", last: null, ruleId: null, strict: false },
      {
        ...dependencies([], jev),
        readRange: async () => ({ status: "RANGE_TOO_LARGE", totalCommits: 73, limit: 50 }),
      },
    );

    expect(result).toEqual({ status: "RANGE_TOO_LARGE", totalCommits: 73, limit: 50 });
    expect(jev.requests).toEqual([]);
  });

  test("an empty range is a completed check with nothing to judge", async () => {
    const result = await executeCheck(
      { range: "main..HEAD", last: null, ruleId: null, strict: false },
      dependencies([]),
    );

    expect(result).toEqual(checked([]));
  });
});

describe("evaluateCheck", () => {
  test("PASS when no rule failed", () => {
    expect(evaluateCheck([ruleResult("PASS")]).verdict).toBe("PASS");
  });

  test("FAIL only from an error-severity rule", () => {
    expect(evaluateCheck([ruleResult("FAIL", "error")])).toMatchObject({
      verdict: "FAIL",
      failures: [{ ruleId: "ARCH-001", sha: SHA }],
    });
  });

  test("a warning-severity FAIL stays a warning", () => {
    const verdict = evaluateCheck([ruleResult("FAIL", "warning")]);

    expect(verdict.verdict).toBe("WARN");
    expect(verdict.failures).toEqual([]);
  });

  test("a WARN is a warning, not a failure", () => {
    expect(evaluateCheck([ruleResult("WARN")]).verdict).toBe("WARN");
  });

  test("UNAVAILABLE and an unparseable patch become INCOMPLETE, never FAIL", () => {
    const unavailable = evaluateCheck([
      {
        sha: SHA,
        status: "REVIEWED",
        review: aggregateReview("rules-check", [
          {
            kind: "RULE",
            turnId: "rules-check",
            ruleId: "ARCH-001",
            severity: "error",
            scopedPaths: [],
            outcome: "UNAVAILABLE",
            reason: "JEV_FAILURE",
          },
        ]),
      },
      { sha: "b".repeat(40), status: "INPUT_FAILED", reason: "BINARY_PATCH" },
    ]);

    expect(unavailable.verdict).toBe("INCOMPLETE");
    expect(unavailable.incomplete).toEqual([
      { sha: SHA, reason: "JEV_FAILURE" },
      { sha: "b".repeat(40), reason: "BINARY_PATCH" },
    ]);
    expect(unavailable.failures).toEqual([]);
  });

  test("a failure outranks incomplete evidence", () => {
    expect(
      evaluateCheck([
        ruleResult("FAIL"),
        { sha: SHA, status: "INPUT_FAILED", reason: "UNRECOGNIZED_DIFF" },
      ]).verdict,
    ).toBe("FAIL");
  });

  test("an unknown rule is its own verdict", () => {
    expect(evaluateCheck([{ sha: SHA, status: "RULE_NOT_FOUND" }]).verdict).toBe("RULE_NOT_FOUND");
  });

  test("counts reviewed and skipped commits", () => {
    const verdict = evaluateCheck([
      ruleResult("PASS"),
      { sha: "b".repeat(40), status: "SKIPPED", reason: "MERGE_COMMIT" },
    ]);

    expect(verdict.reviewedCommitCount).toBe(1);
    expect(verdict.skippedCommitCount).toBe(1);
  });
});

describe("checkExitCode", () => {
  const cases: readonly [string, CheckVerdict["verdict"], boolean, number][] = [
    ["PASS", "PASS", false, 0],
    ["WARN", "WARN", false, 0],
    ["FAIL", "FAIL", false, 1],
    ["INCOMPLETE lenient", "INCOMPLETE", false, 0],
    ["INCOMPLETE strict", "INCOMPLETE", true, 1],
    ["RULE_NOT_FOUND", "RULE_NOT_FOUND", false, 2],
  ];

  test.each(cases)("%s exits %s", (_name, verdict, strict, expected) => {
    expect(
      checkExitCode(
        {
          verdict,
          failures: [],
          warnings: [],
          incomplete: [],
          reviewedCommitCount: 0,
          skippedCommitCount: 0,
        },
        strict,
      ),
    ).toBe(expected);
  });
});

const DIFF_WITH_SENTINEL = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1,2 @@",
  "-old",
  "+new",
  `+${DIFF_SENTINEL}`,
  "",
].join("\n");

describe("check messages", () => {
  test("the text report never prints the subject, the diff or a digest", async () => {
    const result = await executeCheck(
      { range: "main..HEAD", last: null, ruleId: null, strict: false },
      dependencies([commit("a".repeat(40), { diff: DIFF_WITH_SENTINEL })]),
    );
    const verdict = evaluateCheck(result.status === "CHECKED" ? result.commits : []);
    const text = describeCheck(
      result as Extract<CheckResult, { status: "CHECKED" }>,
      verdict,
      "main..HEAD",
      false,
    ).join("\n");

    expect(text).toContain("main..HEAD");
    expect(text).toContain("ARCH-001:FAIL");
    expect(text).not.toContain(SUBJECT_SENTINEL);
    expect(text).not.toContain(DIFF_SENTINEL);
    expect(text).not.toContain("+new");
  });

  test("the JSON report carries the safe allowlist only", async () => {
    const result = (await executeCheck(
      { range: "main..HEAD", last: null, ruleId: null, strict: false },
      dependencies([commit("a".repeat(40))]),
    )) as Extract<CheckResult, { status: "CHECKED" }>;
    const json = serializeCheck(result, evaluateCheck(result.commits));

    expect(json).not.toContain(SUBJECT_SENTINEL);
    expect(json).not.toContain("+new");
    expect(JSON.parse(json)).toMatchObject({
      version: 1,
      status: "CHECKED",
      verdict: "FAIL",
      commits: [{ sha: "a".repeat(40), status: "REVIEWED" }],
    });
  });

  test("annotations escape the rule id and say nothing about the change", () => {
    const verdict = evaluateCheck([
      ruleResult("FAIL"),
      {
        sha: SHA,
        status: "REVIEWED",
        review: aggregateReview("rules-check", [
          {
            kind: "RULE",
            turnId: "rules-check",
            ruleId: "A%B,C:D",
            severity: "error",
            scopedPaths: [],
            outcome: "FAIL",
            violationProbability: 0.9,
          },
        ]),
      },
    ]);
    const annotations = describeCheckAnnotations(verdict).join("\n");

    expect(annotations).toContain("::error title=JevGuard ARCH-001::");
    expect(annotations).toContain("A%25B%2CC%3AD");
    expect(annotations).not.toContain(SUBJECT_SENTINEL);
  });

  test("a passing check gets one notice annotation", () => {
    const annotations = describeCheckAnnotations(evaluateCheck([ruleResult("PASS")]));

    expect(annotations).toEqual(["::notice title=JevGuard::No rule failed over 1 commit(s)."]);
  });
});

describe("createGitRangeReader", () => {
  const run = promisify(execFile);
  let directory = "";

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "jevguard-check-"));
    await git(["init", "--quiet"]);
    await git(["config", "user.name", "test"]);
    await git(["config", "user.email", "test@example.com"]);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function git(args: readonly string[]): Promise<string> {
    const { stdout } = await run("git", [...args], { cwd: directory, windowsHide: true });

    return stdout.trim();
  }

  async function commitFile(name: string, content: string): Promise<string> {
    await writeFile(join(directory, name), `${content}\n`);
    await git(["add", name]);
    await git(["commit", "--quiet", "-m", `add ${name}`]);

    return git(["rev-parse", "HEAD"]);
  }

  test("reads the non-merge commits of the range, newest first", async () => {
    const first = await commitFile("a.txt", "a");
    const second = await commitFile("b.txt", "b");
    const third = await commitFile("c.txt", "c");
    const read = await createGitRangeReader(directory)(`${first}..HEAD`, { newest: null, cap: 50 });

    expect(read.status === "READ" && read.commits.map((entry) => entry.sha)).toEqual([
      third,
      second,
    ]);
  });

  test("excludes merge commits from the count and the units", async () => {
    const base = await commitFile("a.txt", "a");
    await git(["checkout", "--quiet", "-b", "side"]);
    const side = await commitFile("side.txt", "side");
    await git(["checkout", "--quiet", "-"]);
    const main = await commitFile("main.txt", "main");
    await git(["merge", "--quiet", "--no-ff", "side", "-m", "merge side"]);
    const merge = await git(["rev-parse", "HEAD"]);
    const read = await createGitRangeReader(directory)(`${base}..HEAD`, { newest: null, cap: 50 });

    const shas = read.status === "READ" ? read.commits.map((entry) => entry.sha) : [];

    expect([...shas].sort()).toEqual([main, side].sort());
    expect(shas).not.toContain(merge);
  });

  test("an empty range has nothing to read", async () => {
    await commitFile("a.txt", "a");

    expect(await createGitRangeReader(directory)("HEAD..HEAD", { newest: null, cap: 50 })).toEqual({
      status: "READ",
      commits: [],
    });
  });

  test("slices the range to the newest commits with an explicit --last", async () => {
    const first = await commitFile("a.txt", "a");
    await commitFile("b.txt", "b");
    const third = await commitFile("c.txt", "c");
    const read = await createGitRangeReader(directory)(`${first}..HEAD`, {
      newest: 1,
      cap: 50,
    });

    expect(read.status === "READ" && read.commits.map((entry) => entry.sha)).toEqual([third]);
  });

  test("refuses a range above the limit with its count", async () => {
    const first = await commitFile("a.txt", "a");
    await commitFile("b.txt", "b");
    await commitFile("c.txt", "c");

    expect(
      await createGitRangeReader(directory)(`${first}..HEAD`, { newest: null, cap: 1 }),
    ).toEqual({
      status: "RANGE_TOO_LARGE",
      totalCommits: 2,
      limit: 1,
    });
  });

  test("reports an unknown revision as an invalid range", async () => {
    await commitFile("a.txt", "a");

    expect(
      await createGitRangeReader(directory)("definitely-not-a-revision..HEAD", {
        newest: null,
        cap: 50,
      }),
    ).toEqual({
      status: "FAILED",
      reason: "RANGE_INVALID",
    });
  });

  test("carries each commit's own patch, not the whole range", async () => {
    const first = await commitFile("a.txt", "a");
    await commitFile("b.txt", "b");
    const read = await createGitRangeReader(directory)(`${first}..HEAD`, { newest: null, cap: 50 });

    expect(read.status === "READ" && read.commits[0]?.diff).toContain("b.txt");
    expect(read.status === "READ" && read.commits[0]?.diff).not.toContain("a.txt");
  });
});
