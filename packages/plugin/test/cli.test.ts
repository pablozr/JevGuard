import { existsSync, readFileSync } from "node:fs";
import {
  aggregateReview,
  aggregateReviewHistory,
  type FeedbackRecord,
  type ReviewReport,
} from "@jevguard/core";
import type { LoginOutcome, ReviewHistoryRecord } from "@jevguard/node-infra";
import type { InstallOutcome, InstallTarget } from "@jevguard/opencode-adapter";
import { describe, expect, test } from "vitest";
import type { DoctorReport } from "../src/cli/doctor/types";
import type {
  FeedbackListResult,
  FeedbackMarkRequest,
  FeedbackMarkResult,
} from "../src/cli/feedback/types";
import type { RulesCheckRequest, RulesCheckResult } from "../src/cli/rules-check/types";
import { runCli } from "../src/cli/run-cli";
import type { CliDependencies, CliIO } from "../src/cli/types";

const GLOBAL_PATH = "C:/home/.config/opencode/opencode.json";
const PROJECT_PATH = "C:/repo/opencode.json";
const MANUAL_SNIPPET = '{ "plugin": ["@pablozrrrr/jevguard"] }';

const PATH_SENTINEL = "src/SECRET_PATH_SENTINEL.ts";

function reportFixture(feedback: readonly FeedbackRecord[] = []): ReviewReport {
  const record: ReviewHistoryRecord = {
    timestamp: "2026-01-01T00:00:00.000Z",
    turnId: "turn-1",
    summary: {
      highestVerdict: "FAIL",
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 },
    },
    results: [
      {
        kind: "RULE",
        ruleId: "ARCH-001",
        severity: "error",
        scopedPaths: [PATH_SENTINEL],
        outcome: "FAIL",
        violationProbability: 0.9,
      },
    ],
  };

  return aggregateReviewHistory([record], 0, feedback);
}

function doctorFixture(status: DoctorReport["status"]): DoctorReport {
  return {
    version: 1,
    projectRoot: "C:/repo",
    status,
    checks: [
      status === "FAIL"
        ? { id: "credential", status: "FAIL", code: "MISSING_CREDENTIAL" }
        : { id: "credential", status: "OK", code: "CREDENTIAL_STORE" },
      {
        id: "opencode-plugin",
        status: status === "WARN" ? "WARN" : "OK",
        code: status === "WARN" ? "NOT_REGISTERED" : "REGISTERED",
        targets: [
          { status: "NOT_REGISTERED", target: "global", path: GLOBAL_PATH },
          { status: "NOT_REGISTERED", target: "project", path: PROJECT_PATH },
        ],
      },
    ],
  };
}

function failingCheck(): RulesCheckResult {
  return {
    status: "REVIEWED",
    review: aggregateReview("rules-check", [
      {
        kind: "RULE",
        turnId: "rules-check",
        ruleId: "ARCH-001",
        severity: "error",
        scopedPaths: ["src/a.ts"],
        outcome: "FAIL",
        violationProbability: 0.9,
      },
    ]),
  };
}

class RecordingIO implements CliIO {
  readonly out: string[] = [];
  readonly err: string[] = [];

  writeOut(message: string): void {
    this.out.push(message);
  }

  writeErr(message: string): void {
    this.err.push(message);
  }
}

class StubDependencies implements CliDependencies {
  loginCalls = 0;
  loginOutcome: LoginOutcome = { status: "SAVED" };
  installCalls = 0;
  readonly installTargets: InstallTarget[] = [];
  installOutcome: InstallOutcome = {
    status: "INSTALLED",
    target: "global",
    path: GLOBAL_PATH,
  };
  reportCalls = 0;
  reportResult: ReviewReport = aggregateReviewHistory([], 0, []);
  doctorCalls = 0;
  doctorError: Error | null = null;
  doctorResult: DoctorReport = doctorFixture("OK");
  feedbackError: Error | null = null;
  readonly feedbackMarkRequests: FeedbackMarkRequest[] = [];
  feedbackListResult: FeedbackListResult = {
    status: "LISTED",
    listedAt: "2026-01-01T00:00:00.000Z",
    total: 1,
    items: [
      {
        number: 1,
        ruleId: "ARCH-001",
        turnId: "turn-1",
        timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
        violationProbability: 0.91,
      },
    ],
  };
  feedbackMarkResult: FeedbackMarkResult = {
    status: "RECORDED",
    ruleId: "ARCH-001",
    decision: "WRONG",
    previous: null,
    timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    violationProbability: 0.91,
  };
  rulesCheckCalls = 0;
  rulesCheckError: Error | null = null;
  readonly rulesCheckRequests: RulesCheckRequest[] = [];
  rulesCheckResult: RulesCheckResult = {
    status: "REVIEWED",
    review: aggregateReview("rules-check", []),
  };

  login(): Promise<LoginOutcome> {
    this.loginCalls += 1;
    return Promise.resolve(this.loginOutcome);
  }

  install(target: InstallTarget): Promise<InstallOutcome> {
    this.installCalls += 1;
    this.installTargets.push(target);
    return Promise.resolve(this.installOutcome);
  }

  report(): Promise<ReviewReport> {
    this.reportCalls += 1;
    return Promise.resolve(this.reportResult);
  }

  doctor(): Promise<DoctorReport> {
    this.doctorCalls += 1;

    return this.doctorError === null
      ? Promise.resolve(this.doctorResult)
      : Promise.reject(this.doctorError);
  }

  feedbackList(): Promise<FeedbackListResult> {
    return this.feedbackError === null
      ? Promise.resolve(this.feedbackListResult)
      : Promise.reject(this.feedbackError);
  }

  feedbackMark(request: FeedbackMarkRequest): Promise<FeedbackMarkResult> {
    this.feedbackMarkRequests.push(request);

    return this.feedbackError === null
      ? Promise.resolve(this.feedbackMarkResult)
      : Promise.reject(this.feedbackError);
  }

  rulesCheck(request: RulesCheckRequest): Promise<RulesCheckResult> {
    this.rulesCheckCalls += 1;
    this.rulesCheckRequests.push(request);

    return this.rulesCheckError === null
      ? Promise.resolve(this.rulesCheckResult)
      : Promise.reject(this.rulesCheckError);
  }
}

function harness(): { io: RecordingIO; dependencies: StubDependencies } {
  return { io: new RecordingIO(), dependencies: new StubDependencies() };
}

describe("runCli dispatch", () => {
  test("runs login and reports success for the login command", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.loginCalls).toBe(1);
    expect(io.out.join("\n")).toContain("Credential saved");
    expect(io.err).toEqual([]);
  });

  test("prints usage and fails when no command is given", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli([], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.loginCalls).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects an unknown command", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["logout"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.loginCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects extra arguments, including a secret-looking value", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["login", "test-key"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.loginCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
    expect(io.err.join("\n")).not.toContain("test-key");
  });

  test("reports an aborted prompt without a success message", async () => {
    const { io, dependencies } = harness();
    dependencies.loginOutcome = { status: "ABORTED" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Login cancelled");
  });

  test("reports a non-TTY login as an actionable failure", async () => {
    const { io, dependencies } = harness();
    dependencies.loginOutcome = { status: "FAILED", reason: "NOT_A_TTY" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("interactive terminal");
  });

  test("reports a store failure without serializing a native error", async () => {
    const { io, dependencies } = harness();
    dependencies.loginOutcome = { status: "FAILED", reason: "STORE_WRITE_FAILURE" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("OS credential store");
    expect(io.err.join("\n")).not.toContain("test-key");
  });

  test("dispatches install to the global target and reports success", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.installTargets).toEqual(["global"]);
    expect(io.out.join("\n")).toContain(GLOBAL_PATH);
    expect(io.err).toEqual([]);
  });

  test("dispatches install --project to the project target", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "INSTALLED",
      target: "project",
      path: PROJECT_PATH,
    };

    const exitCode = await runCli(["install", "--project"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.installTargets).toEqual(["project"]);
    expect(io.out.join("\n")).toContain(PROJECT_PATH);
  });

  test("reports an already-installed plugin as success without rewriting", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "ALREADY_INSTALLED",
      target: "global",
      path: GLOBAL_PATH,
    };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("already registered");
    expect(io.err).toEqual([]);
  });

  test("rejects install with an unknown flag without calling the dependency", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["install", "--other"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.installCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects install with an extra argument and never echoes it", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["install", "test-key"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.installCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
    expect(io.err.join("\n")).not.toContain("test-key");
  });

  test("reports an aborted install without a success message", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = { status: "ABORTED", target: "global", path: GLOBAL_PATH };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Install cancelled");
  });

  test("prints the manual snippet when the install cannot confirm off a TTY", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "NOT_A_TTY",
    };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain(MANUAL_SNIPPET);
  });

  test("prints the manual snippet when a JSONC config blocks the install", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "UNSUPPORTED_JSONC",
    };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain(MANUAL_SNIPPET);
  });
});

describe("runCli report", () => {
  test("prints a human summary and exits zero", async () => {
    const { io, dependencies } = harness();
    dependencies.reportResult = reportFixture();

    const exitCode = await runCli(["report"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.reportCalls).toBe(1);
    expect(io.err).toEqual([]);
    expect(io.out.join("\n")).toContain("JevGuard review history");
    expect(io.out.join("\n")).toContain("ARCH-001");
  });

  test("prints the same aggregation as JSON for report --json", async () => {
    const { io, dependencies } = harness();
    dependencies.reportResult = reportFixture();

    const exitCode = await runCli(["report", "--json"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(io.err).toEqual([]);
    expect(JSON.parse(io.out.join("\n"))).toEqual(dependencies.reportResult);
  });

  test("treats a missing or empty history as a normal empty report", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["report"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(io.err).toEqual([]);
    expect(io.out.join("\n")).toBe("No review history yet.");
  });

  test("rejects an unknown report argument without echoing it", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["report", "SECRET_VALUE"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.reportCalls).toBe(0);
    expect(io.err.join("\n")).toContain("jevguard report [--json]");
    expect(io.err.join("\n")).not.toContain("SECRET_VALUE");
  });

  test("never prints a path or a diff sentinel", async () => {
    const { io, dependencies } = harness();
    dependencies.reportResult = reportFixture();

    await runCli(["report"], io, dependencies);
    await runCli(["report", "--json"], io, dependencies);

    const output = io.out.join("\n");

    expect(output).not.toContain(PATH_SENTINEL);
    expect(output).not.toContain("src/");
    expect(output).not.toContain("--- a/");
    expect(output).not.toContain("@@");
  });
});

describe("runCli doctor", () => {
  test("prints the report and exits 0 when nothing fails", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["doctor"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.doctorCalls).toBe(1);
    expect(io.out.join("\n")).toContain("JevGuard doctor");
    expect(io.err).toEqual([]);
  });

  test("exits 1 when any check fails", async () => {
    const { io, dependencies } = harness();
    dependencies.doctorResult = doctorFixture("FAIL");

    expect(await runCli(["doctor"], io, dependencies)).toBe(1);
    expect(io.out.join("\n")).toContain("Result: FAIL");
  });

  test("exits 0 when there are only warnings", async () => {
    const { io, dependencies } = harness();
    dependencies.doctorResult = doctorFixture("WARN");

    expect(await runCli(["doctor"], io, dependencies)).toBe(0);
  });

  test("prints a JSON report that round-trips with --json", async () => {
    const { io, dependencies } = harness();
    dependencies.doctorResult = doctorFixture("WARN");

    const exitCode = await runCli(["doctor", "--json"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.out.join("\n"))).toEqual(dependencies.doctorResult);
  });

  test("reports a generic failure when the diagnosis throws", async () => {
    const { io, dependencies } = harness();
    dependencies.doctorError = new Error("SECRET_VALUE");

    const exitCode = await runCli(["doctor"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toBe("Could not run the diagnostics.");
  });

  test("rejects an unknown doctor argument without echoing it", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["doctor", "SECRET_VALUE"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.doctorCalls).toBe(0);
    expect(io.err.join("\n")).toContain("jevguard doctor [--json]");
    expect(io.err.join("\n")).not.toContain("SECRET_VALUE");
  });
});

describe("runCli rules check", () => {
  test("passes a stdin request to the dependency", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["rules", "check", "--diff", "-"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.rulesCheckRequests[0]?.diff.kind).toBe("STDIN");
    expect(io.out.join("\n")).toContain("JevGuard rules check");
  });

  test("exits 1 when a rule fails", async () => {
    const { io, dependencies } = harness();
    dependencies.rulesCheckResult = failingCheck();

    expect(await runCli(["rules", "check", "--diff", "-"], io, dependencies)).toBe(1);
    expect(io.out.join("\n")).toContain("ARCH-001");
  });

  test("prints versioned JSON with --json", async () => {
    const { io, dependencies } = harness();
    dependencies.rulesCheckResult = failingCheck();

    await runCli(["rules", "check", "--diff", "-", "--json"], io, dependencies);

    expect(JSON.parse(io.out.join("\n"))).toMatchObject({ version: 1, turnId: "rules-check" });
  });

  test("exits 2 for an unknown rule without echoing the id", async () => {
    const { io, dependencies } = harness();
    dependencies.rulesCheckResult = { status: "RULE_NOT_FOUND" };

    const exitCode = await runCli(
      ["rules", "check", "--diff", "-", "--rule", "SECRET_VALUE"],
      io,
      dependencies,
    );

    expect(exitCode).toBe(2);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).not.toContain("SECRET_VALUE");
  });

  test("exits 2 and explains failed input", async () => {
    const { io, dependencies } = harness();
    dependencies.rulesCheckResult = { status: "INPUT_FAILED", reason: "BINARY_PATCH" };

    const exitCode = await runCli(["rules", "check", "--diff", "x.diff"], io, dependencies);

    expect(exitCode).toBe(2);
    expect(io.err.join("\n")).toContain("binary");
  });

  test("exits 2 with a generic message when the dependency throws", async () => {
    const { io, dependencies } = harness();
    dependencies.rulesCheckError = new Error("SECRET_VALUE");

    const exitCode = await runCli(["rules", "check", "--diff", "-"], io, dependencies);

    expect(exitCode).toBe(2);
    expect(io.err.join("\n")).toBe("Could not run the rule check.");
  });

  test("exits 2 on invalid arguments without calling the dependency or echoing them", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["rules", "check", "--bogus", "SECRET_VALUE"], io, dependencies);

    expect(exitCode).toBe(2);
    expect(dependencies.rulesCheckCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard rules check");
    expect(io.err.join("\n")).not.toContain("SECRET_VALUE");
  });

  test("a bare rules command prints the global usage and exits 1", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["rules"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("the global usage lists the new commands", async () => {
    const { io, dependencies } = harness();

    await runCli([], io, dependencies);

    const usage = io.err.join("\n");

    expect(usage).toContain("jevguard doctor [--json]");
    expect(usage).toContain(
      "jevguard rules check --diff <file|-> [--task <text>] [--rule <id>] [--json]",
    );
  });
});

describe("runCli feedback", () => {
  test("lists unanswered FAILs with the answer instructions", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["feedback"], io, dependencies);
    const output = io.out.join("\n");

    expect(exitCode).toBe(0);
    expect(io.err).toEqual([]);
    expect(output).toContain("ARCH-001");
    expect(output).toContain("p=0.91");
    expect(output).toContain("min ago");
    expect(output).toContain("Answer with:");
    expect(output).toContain("jevguard feedback 1 wrong");
  });

  test("prints the listing as versioned JSON for --json", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["feedback", "--json"], io, dependencies);
    const parsed = JSON.parse(io.out.join("\n"));

    expect(exitCode).toBe(0);
    expect(parsed.version).toBe(1);
    expect(parsed.total).toBe(1);
    expect(parsed.items.map((item: { number: number }) => item.number)).toEqual([1]);
  });

  test("states an empty list plainly", async () => {
    const { io, dependencies } = harness();
    dependencies.feedbackListResult = {
      status: "LISTED",
      listedAt: "2026-01-01T00:00:00.000Z",
      total: 0,
      items: [],
    };

    const exitCode = await runCli(["feedback"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toBe("No unanswered FAILs.");
  });

  test.each([
    ["wrong", "Marked as a false alarm: ARCH-001 (3 h ago, p=0.91).", "WRONG"],
    ["right", "Marked as a real violation: ARCH-001 (3 h ago, p=0.91).", "RIGHT"],
  ] as const)("marks a FAIL as %s", async (answer, message, decision) => {
    const { io, dependencies } = harness();
    dependencies.feedbackMarkResult = {
      status: "RECORDED",
      ruleId: "ARCH-001",
      decision,
      previous: null,
      timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      violationProbability: 0.91,
    };

    const exitCode = await runCli(["feedback", "1", answer], io, dependencies);

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toBe(message);
    expect(dependencies.feedbackMarkRequests).toEqual([{ number: 1, decision }]);
  });

  test("exits zero for an answer that was already recorded", async () => {
    const { io, dependencies } = harness();
    dependencies.feedbackMarkResult = {
      status: "UNCHANGED",
      ruleId: "ARCH-001",
      decision: "WRONG",
      timestamp: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      violationProbability: 0.91,
    };

    const exitCode = await runCli(["feedback", "1", "wrong"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toBe("Already marked as a false alarm: ARCH-001 (3 h ago, p=0.91).");
  });

  test.each([
    ["NO_SELECTION", 1, "Run `jevguard feedback` first"],
    ["NUMBER_OUT_OF_RANGE", 1, "No FAIL has that number"],
    ["NO_LONGER_IN_HISTORY", 1, "no longer in the review history"],
    ["READ_FAILED", 2, "Could not read the local review history or feedback."],
    ["WRITE_FAILED", 2, "Could not save the feedback."],
  ] as const)("reports %s on stderr with exit %i", async (status, code, message) => {
    const { io, dependencies } = harness();
    dependencies.feedbackMarkResult = { status };

    const exitCode = await runCli(["feedback", "1", "wrong"], io, dependencies);

    expect(exitCode).toBe(code);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain(message);
  });

  test("exits 2 when the listing cannot be stored", async () => {
    const { io, dependencies } = harness();
    dependencies.feedbackListResult = { status: "WRITE_FAILED" };

    const exitCode = await runCli(["feedback"], io, dependencies);

    expect(exitCode).toBe(2);
    expect(io.err.join("\n")).toContain("Could not save the feedback.");
  });

  test.each([["maybe"], ["WRONG"]])(
    "rejects the decision %s without calling the dependency or echoing it",
    async (answer) => {
      const { io, dependencies } = harness();

      const exitCode = await runCli(["feedback", "1", answer], io, dependencies);

      expect(exitCode).toBe(1);
      expect(dependencies.feedbackMarkRequests).toEqual([]);
      expect(io.err.join("\n")).toContain("right (a real violation) or wrong (a false alarm)");
      expect(io.err.join("\n")).not.toContain(answer);
    },
  );

  test.each([
    [["feedback", "abc", "wrong"]],
    [["feedback", "0", "wrong"]],
    [["feedback", "1"]],
    [["feedback", "1", "wrong", "extra"]],
    [["feedback", "--json", "extra"]],
  ])("prints the feedback usage for %j without echoing arguments", async (argv) => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(argv, io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.feedbackMarkRequests).toEqual([]);
    expect(io.err.join("\n")).toContain("jevguard feedback <number> <right|wrong>");
    expect(io.err.join("\n")).not.toContain("abc");
    expect(io.err.join("\n")).not.toContain("extra");
  });

  test("exits 2 when a dependency throws", async () => {
    const { io, dependencies } = harness();
    dependencies.feedbackError = new Error("SECRET_VALUE");

    const listExit = await runCli(["feedback"], io, dependencies);
    const markExit = await runCli(["feedback", "1", "wrong"], io, dependencies);

    expect(listExit).toBe(2);
    expect(markExit).toBe(2);
    expect(io.err.join("\n")).toContain("Could not complete the feedback command.");
    expect(io.err.join("\n")).not.toContain("SECRET_VALUE");
  });

  test("lists feedback in the top-level usage", async () => {
    const { io, dependencies } = harness();

    await runCli(["bogus"], io, dependencies);

    expect(io.err.join("\n")).toContain("jevguard feedback [--json]");
    expect(io.err.join("\n")).toContain("jevguard feedback <number> <right|wrong>");
  });
});

describe("runCli report calibration", () => {
  test("shows feedback calibration per rule", async () => {
    const { io, dependencies } = harness();
    dependencies.reportResult = reportFixture([
      {
        turnId: "turn-1",
        ruleId: "ARCH-001",
        decision: "RIGHT",
        timestamp: "2026-01-02T00:00:00.000Z",
      },
    ]);

    await runCli(["report"], io, dependencies);

    expect(io.out.join("\n")).toContain(
      "feedback right 1 · wrong 0 · unanswered 0 · precision 1.00",
    );
  });

  test("shows n/a precision without feedback", async () => {
    const { io, dependencies } = harness();
    dependencies.reportResult = reportFixture();

    await runCli(["report"], io, dependencies);

    expect(io.out.join("\n")).toContain("unanswered 1 · precision n/a");
  });

  test("includes calibration in report --json", async () => {
    const { io, dependencies } = harness();
    dependencies.reportResult = reportFixture();

    await runCli(["report", "--json"], io, dependencies);

    expect(JSON.parse(io.out.join("\n")).rules[0].calibration).toEqual({
      right: 0,
      wrong: 0,
      unanswered: 1,
      precision: null,
    });
  });
});

describe("package bin wiring", () => {
  test("declares the jevguard bin and ships its entry file", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin?: Record<string, string> };

    expect(manifest.bin?.jevguard).toBe("./src/cli/main.ts");
    expect(existsSync(new URL("../src/cli/main.ts", import.meta.url))).toBe(true);
  });

  test("runs the CLI entry file under the Bun runtime", () => {
    const entry = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");

    expect(entry.startsWith("#!/usr/bin/env bun")).toBe(true);
  });
});
