import type {
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleEvaluationResult,
  JevRuleRequest,
  PolicyLoader,
  PolicyLoadResult,
} from "@jevguard/core";
import { parsePolicyConfig, toReviewLogEntry } from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import { parseReplayArguments } from "../src/replay/arguments";
import { executeReplay } from "../src/replay/execute";
import { describeReplay, serializeReplay } from "../src/replay/messages";
import type {
  HistoryRead,
  ReplayedCommit,
  ReplayDependencies,
  ReplayResult,
} from "../src/replay/types";

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

describe("parseReplayArguments", () => {
  test("defaults to five commits, every rule, human output", () => {
    expect(parseReplayArguments([])).toEqual({
      request: { last: 5, ruleId: null },
      json: false,
    });
  });

  test("parses --last, --rule and --json", () => {
    expect(parseReplayArguments(["--last", "12", "--rule", "ARCH-001", "--json"])).toEqual({
      request: { last: 12, ruleId: "ARCH-001" },
      json: true,
    });
  });

  test.each([
    ["zero", ["--last", "0"]],
    ["a fraction", ["--last", "1.5"]],
    ["above the limit", ["--last", "51"]],
    ["a duplicated --last", ["--last", "2", "--last", "3"]],
    ["a flag without a value", ["--last"]],
    ["a positional argument", ["2"]],
    ["an unknown flag", ["--since", "1w"]],
  ])("refuses %s", (_name, args) => {
    expect(parseReplayArguments(args)).toBeNull();
  });
});

class FakeJevPort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);

    if (request.kind === "BUILT_IN_BATCH") {
      return { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "API_ERROR" };
    }

    return { kind: "RULE", status: "EVALUATED", noul: { violationProbability: 0.82 } };
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

function rule(id: string): string {
  return [
    `## ${id}`,
    "",
    "severity: error",
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

function dependencies(history: HistoryRead, jev = new FakeJevPort()): ReplayDependencies {
  return {
    readHistory: async () => history,
    policy: new FakePolicy({ status: "LOADED", source: { rules: rule("ARCH-001"), config: null } }),
    parseConfig: parsePolicyConfig,
    jev,
  };
}

describe("executeReplay", () => {
  test("reviews each commit's own patch with its subject as the task", async () => {
    const jev = new FakeJevPort();
    const history: HistoryRead = {
      status: "READ",
      commits: [commit("a".repeat(40)), commit("b".repeat(40))],
    };

    const result = await executeReplay({ last: 2, ruleId: null }, dependencies(history, jev));

    expect(result.status).toBe("REPLAYED");
    expect(jev.requests).toHaveLength(2);
    expect(jev.requests.map((request) => request.task)).toEqual([
      SUBJECT_SENTINEL,
      SUBJECT_SENTINEL,
    ]);
  });

  test("skips merge commits and commits without a patch", async () => {
    const jev = new FakeJevPort();
    const history: HistoryRead = {
      status: "READ",
      commits: [
        commit("c".repeat(40), { merge: true }),
        commit("d".repeat(40), { diff: "" }),
        commit("e".repeat(40)),
      ],
    };

    const result = await executeReplay({ last: 3, ruleId: null }, dependencies(history, jev));

    expect(result.status === "REPLAYED" && result.commits.map((entry) => entry.status)).toEqual([
      "SKIPPED",
      "SKIPPED",
      "REVIEWED",
    ]);
    expect(jev.requests).toHaveLength(1);
  });

  test("reports a patch the rules check cannot parse instead of guessing", async () => {
    const history: HistoryRead = {
      status: "READ",
      commits: [commit("f".repeat(40), { diff: "not a diff" })],
    };

    const result = await executeReplay({ last: 1, ruleId: null }, dependencies(history));

    expect(result.status === "REPLAYED" && result.commits[0]).toMatchObject({
      status: "INPUT_FAILED",
      reason: "UNRECOGNIZED_DIFF",
    });
  });

  test("a patch the reader had to cut is not judged, never passed as a complete diff", async () => {
    const jev = new FakeJevPort();
    const history: HistoryRead = {
      status: "READ",
      commits: [commit("a".repeat(40), { diffTruncated: true })],
    };

    const result = await executeReplay({ last: 1, ruleId: null }, dependencies(history, jev));

    expect(result.status === "REPLAYED" && result.commits[0]).toEqual({
      sha: "a".repeat(40),
      status: "INPUT_FAILED",
      reason: "DIFF_TOO_LARGE",
    });
    expect(jev.requests).toHaveLength(0);
  });

  test("passes an unreadable history through as FAILED", async () => {
    const result = await executeReplay(
      { last: 5, ruleId: null },
      dependencies({ status: "FAILED", reason: "GIT_UNAVAILABLE" }),
    );

    expect(result).toEqual({ status: "FAILED", reason: "GIT_UNAVAILABLE" });
  });
});

describe("describeReplay", () => {
  test("prints a revision and its verdict but never the subject or the diff", async () => {
    const history: HistoryRead = { status: "READ", commits: [commit("a1b2c3d4e5")] };
    const result = (await executeReplay(
      { last: 1, ruleId: null },
      dependencies(history),
    )) as Extract<ReplayResult, { status: "REPLAYED" }>;

    const text = describeReplay(result, 1).join("\n");

    expect(text).toContain("a1b2c3d");
    expect(text).toContain("ARCH-001:FAIL");
    expect(text).toContain("Nothing was written");
    expect(text).not.toContain(SUBJECT_SENTINEL);
    expect(text).not.toContain("+new");
  });

  test("the JSON form carries the safe log shape and no subject or diff", async () => {
    const history: HistoryRead = { status: "READ", commits: [commit("a".repeat(40))] };
    const result = (await executeReplay(
      { last: 1, ruleId: null },
      dependencies(history),
    )) as Extract<ReplayResult, { status: "REPLAYED" }>;

    const json = serializeReplay(result);

    expect(json).not.toContain(SUBJECT_SENTINEL);
    expect(json).not.toContain("+new");
    expect(JSON.parse(json)).toMatchObject({
      status: "REPLAYED",
      commits: [{ sha: "a".repeat(40) }],
    });
  });

  test("the reviewed summary is the safe log entry", async () => {
    const history: HistoryRead = { status: "READ", commits: [commit("a".repeat(40))] };
    const result = (await executeReplay(
      { last: 1, ruleId: null },
      dependencies(history),
    )) as Extract<ReplayResult, { status: "REPLAYED" }>;
    const commitResult = result.commits[0];

    expect(
      commitResult?.status === "REVIEWED" && toReviewLogEntry(commitResult.review).summary,
    ).toMatchObject({
      highestVerdict: "FAIL",
    });
  });

  test("an unreadable history prints the reason, not a diff", () => {
    expect(describeReplay({ status: "FAILED", reason: "NO_COMMITS" }, 5).join("\n")).toContain(
      "There are no commits to replay",
    );
  });
});
