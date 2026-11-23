import type { EnforceUserSettingsResult, ReviewLogResult } from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import {
  enforceStop,
  waitForReview,
  type EnforceEnvironment,
  type EnforceResultFacts,
  type EnforceStopDependencies,
} from "../src/enforce";
import type { EnforceClosedUnit, EnforceGateLogCode } from "../src/enforce/types";
import type { ReviewHistoryRecord } from "@jevguard/node-infra";
import type { StopEvent } from "../src/hook-event";

const CLOSED: EnforceClosedUnit = {
  sessionId: "session-1",
  sessionDirectory: "/state/sessions/session-1",
  turnId: "claude-code:session-1:0123456789abcdef:0",
  projectRoot: "/project",
  epoch: "0123456789abcdef",
  ordinal: 0,
  handoffCreated: true,
};

const ENABLED: EnforceUserSettingsResult = {
  status: "ENABLED",
  settings: { rules: ["SECRETS-001", "DESTRUCTIVE-001"], budgetMs: 8000 },
  warnings: [],
};

const ATTENDED: Record<string, string> = {
  CLAUDE_CODE_SESSION_ATTENDED: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
};

function environmentOf(values: Record<string, string>): EnforceEnvironment {
  return { get: (name) => values[name] };
}

function stop(overrides: Partial<StopEvent> = {}): StopEvent {
  return {
    name: "Stop",
    sessionId: "session-1",
    cwd: "/project",
    promptId: null,
    agentId: null,
    backgroundTasks: "EMPTY",
    stopHookActive: false,
    ...overrides,
  };
}

function rule(
  ruleId: string,
  outcome: "PASS" | "WARN" | "FAIL" | "UNAVAILABLE" | "SKIPPED",
  severity: "error" | "warning" = "error",
): EnforceResultFacts {
  return { kind: "RULE", ruleId, severity, outcome };
}

interface Harness {
  readonly dependencies: EnforceStopDependencies;
  readonly reports: EnforceGateLogCode[];
  readonly recorded: EnforceClosedUnit[];
  readonly waited: { turnId: string; budgetMs: number }[];
}

function harness(overrides: Partial<EnforceStopDependencies> = {}): Harness {
  const reports: EnforceGateLogCode[] = [];
  const recorded: EnforceClosedUnit[] = [];
  const waited: { turnId: string; budgetMs: number }[] = [];
  const dependencies: EnforceStopDependencies = {
    environment: environmentOf(ATTENDED),
    settingsFor: () => ENABLED,
    waitForReview: async (turnId, budgetMs) => {
      waited.push({ turnId, budgetMs });

      return [rule("SECRETS-001", "FAIL")];
    },
    blockedUnits: {
      isBlocked: () => false,
      record: (unit) => void recorded.push(unit),
    },
    ackStateFor: async () => "NOT_ACKED",
    remainingBudgetMs: () => 15_000,
    report: (code) => void reports.push(code),
    ...overrides,
  };

  return { dependencies, reports, recorded, waited };
}

describe("enforceStop", () => {
  test("blocks on an allowlisted error rule in FAIL and names only rule IDs", async () => {
    const { dependencies, reports, recorded, waited } = harness();
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision).toEqual({
      decision: "block",
      reason:
        "JevGuard blocked this turn: SECRETS-001 failed. Fix the change, or explain why the rule does not apply, then finish the turn again.",
    });
    expect(Object.keys(decision ?? {})).toEqual(["decision", "reason"]);
    expect(recorded).toEqual([CLOSED]);
    expect(waited).toEqual([{ turnId: CLOSED.turnId, budgetMs: 8000 }]);
    expect(reports).toEqual(["ENFORCE_BLOCKED"]);
  });

  test("waits no longer than what is left of the hook's allowance", async () => {
    const { dependencies, waited } = harness({ remainingBudgetMs: () => 2500 });

    await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(waited).toEqual([{ turnId: CLOSED.turnId, budgetMs: 2500 }]);
  });

  test("fails open on a review that does not settle in time", async () => {
    const { dependencies, reports, recorded } = harness({ waitForReview: async () => null });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision).toBeNull();
    expect(reports).toEqual(["ENFORCE_TIMEOUT"]);
    expect(recorded).toEqual([]);
  });

  test("does not wait at all when no time is left", async () => {
    const { dependencies, reports, waited } = harness({ remainingBudgetMs: () => 0 });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(reports).toEqual(["ENFORCE_TIMEOUT"]);
  });

  test("a session the host did not positively call interactive never blocks", async () => {
    for (const values of [
      { CLAUDE_CODE_SESSION_ATTENDED: "0" },
      { CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-cli" },
      { CLAUDE_CODE_SESSION_ATTENDED: "yes" },
      {},
    ]) {
      const { dependencies, reports, waited } = harness({ environment: environmentOf(values) });
      const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

      expect(decision).toBeNull();
      expect(waited).toEqual([]);
      expect(reports).toEqual(["ENFORCE_NON_INTERACTIVE"]);
    }
  });

  test("is silent when the user's file does not enable enforce", async () => {
    const { dependencies, reports, waited } = harness({
      settingsFor: () => ({ status: "DISABLED" }),
    });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(reports).toEqual([]);
  });

  test("an invalid user file fails open and is logged as a closed code", async () => {
    const { dependencies, reports, waited } = harness({
      settingsFor: () => ({ status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" }),
    });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(reports).toEqual(["ENFORCE_CONFIG_INVALID"]);
  });

  test("a continued stop never blocks again", async () => {
    const { dependencies, reports, waited } = harness();
    const decision = await enforceStop(
      { event: stop({ stopHookActive: true }), closed: CLOSED },
      dependencies,
    );

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(reports).toEqual(["ENFORCE_CAP_REACHED"]);
  });

  test("one block per unit: a unit already blocked is never blocked twice", async () => {
    const { dependencies, reports, waited, recorded } = harness({
      blockedUnits: { isBlocked: () => true, record: (unit) => void recorded.push(unit) },
    });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(recorded).toEqual([]);
    expect(reports).toEqual(["ENFORCE_CAP_REACHED"]);
  });

  test("an unreadable background-task state fails open before waiting", async () => {
    const { dependencies, reports, waited } = harness();
    const decision = await enforceStop(
      { event: stop({ backgroundTasks: "UNKNOWN" }), closed: CLOSED },
      dependencies,
    );

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(reports).toEqual(["ENFORCE_BACKGROUND_TASK"]);
  });

  test("an acknowledged unit is never blocked and is not waited for", async () => {
    const { dependencies, reports, recorded, waited } = harness({
      ackStateFor: async () => "ACKED",
    });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(recorded).toEqual([]);
    expect(reports).toEqual(["ENFORCE_ACKED"]);
  });

  test("an unreadable ledger is a closed code and enforce still stands", async () => {
    const { dependencies, reports, recorded } = harness({
      ackStateFor: async () => "UNREADABLE",
    });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision?.decision).toBe("block");
    expect(recorded).toEqual([CLOSED]);
    expect(reports).toEqual(["ENFORCE_ACK_UNREADABLE", "ENFORCE_BLOCKED"]);
  });

  test("a unit whose handoff was never written has no review to wait for", async () => {
    const { dependencies, reports, waited } = harness();
    const decision = await enforceStop(
      { event: stop(), closed: { ...CLOSED, handoffCreated: false } },
      dependencies,
    );

    expect(decision).toBeNull();
    expect(waited).toEqual([]);
    expect(reports).toEqual(["ENFORCE_NO_REVIEW"]);
  });

  test("a warning rule, a built-in and an operational result never block", async () => {
    const cases: readonly EnforceResultFacts[][] = [
      [rule("SECRETS-001", "FAIL", "warning")],
      [{ kind: "BUILT_IN", ruleId: null, severity: "error", outcome: "FAIL" }],
      [rule("SECRETS-001", "UNAVAILABLE")],
      [rule("SECRETS-001", "PASS")],
      [{ kind: "REVIEW", ruleId: null, severity: null, outcome: "UNAVAILABLE" }],
      [rule("OTHER-001", "FAIL")],
    ];

    for (const results of cases) {
      const { dependencies, reports, recorded } = harness({ waitForReview: async () => results });
      const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

      expect(decision).toBeNull();
      expect(recorded).toEqual([]);
      expect(reports).toEqual(["ENFORCE_NO_FAIL"]);
    }
  });

  test("blocks on every allowlisted failing rule, in configured order", async () => {
    const { dependencies } = harness({
      waitForReview: async () => [rule("DESTRUCTIVE-001", "FAIL"), rule("SECRETS-001", "FAIL")],
    });
    const decision = await enforceStop({ event: stop(), closed: CLOSED }, dependencies);

    expect(decision?.reason).toContain("SECRETS-001, DESTRUCTIVE-001");
  });
});

function historyRecord(turnId: string, results: readonly ReviewLogResult[]): ReviewHistoryRecord {
  return {
    turnId,
    timestamp: "2026-11-21T12:00:00.000Z",
    summary: {
      highestVerdict: "FAIL",
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 },
    },
    results,
  };
}

const LOGGED_FAIL: ReviewLogResult = {
  kind: "RULE",
  ruleId: "SECRETS-001",
  severity: "error",
  scopedPaths: ["src/a.ts"],
  outcome: "FAIL",
  violationProbability: 0.91,
};

interface Clock {
  now: number;
}

function watchHarness(records: () => readonly ReviewHistoryRecord[], clock: Clock) {
  let reads = 0;
  const slept: number[] = [];

  return {
    dependencies: {
      history: {
        readStrict: async () => {
          reads += 1;

          return { status: "READ" as const, records: records(), skippedLineCount: 0 };
        },
      },
      historyPath: "/data/reviews.jsonl",
      statOf: () => ({ size: reads, mtimeMs: reads }),
      sleep: async (ms: number) => {
        slept.push(ms);
        clock.now += ms;
      },
      monotonicNow: () => clock.now,
    },
    reads: () => reads,
    slept,
  };
}

describe("waitForReview", () => {
  test("returns only the facts of the requested unit", async () => {
    const clock = { now: 0 };
    const harnessed = watchHarness(
      () => [
        historyRecord(CLOSED.turnId, [LOGGED_FAIL]),
        historyRecord("claude-code:other:0123456789abcdef:3", []),
      ],
      clock,
    );

    const facts = await waitForReview(harnessed.dependencies, CLOSED.turnId, 8000);

    expect(facts).toEqual([
      { kind: "RULE", ruleId: "SECRETS-001", severity: "error", outcome: "FAIL" },
    ]);
    expect(harnessed.reads()).toBe(1);
  });

  test("waits for a review that lands after the wait started", async () => {
    const clock = { now: 0 };
    let reads = 0;
    const slept: number[] = [];
    const dependencies = {
      history: {
        readStrict: async () => {
          reads += 1;

          return {
            status: "READ" as const,
            records: reads >= 3 ? [historyRecord(CLOSED.turnId, [LOGGED_FAIL])] : [],
            skippedLineCount: 0,
          };
        },
      },
      historyPath: "/data/reviews.jsonl",
      statOf: () => ({ size: reads, mtimeMs: reads }),
      sleep: async (ms: number) => {
        slept.push(ms);
        clock.now += ms;
      },
      monotonicNow: () => clock.now,
    };

    const facts = await waitForReview(dependencies, CLOSED.turnId, 8000);

    expect(facts).not.toBeNull();
    expect(reads).toBe(3);
    expect(slept).toEqual([100, 100]);
  });

  test("gives up at the deadline without a decision", async () => {
    const clock = { now: 0 };
    const harnessed = watchHarness(() => [], clock);

    const facts = await waitForReview(harnessed.dependencies, CLOSED.turnId, 300);

    expect(facts).toBeNull();
    expect(clock.now).toBeGreaterThanOrEqual(300);
  });

  test("does not re-read a history file whose metadata did not move", async () => {
    const clock = { now: 0 };
    let reads = 0;
    const dependencies = {
      history: {
        readStrict: async () => {
          reads += 1;

          return { status: "READ" as const, records: [], skippedLineCount: 0 };
        },
      },
      historyPath: "/data/reviews.jsonl",
      statOf: () => ({ size: 10, mtimeMs: 1 }),
      sleep: async (ms: number) => {
        clock.now += ms;
      },
      monotonicNow: () => clock.now,
    };

    expect(await waitForReview(dependencies, CLOSED.turnId, 1000)).toBeNull();
    expect(reads).toBe(1);
  });

  test("an unreadable history is simply not yet", async () => {
    const clock = { now: 0 };
    const dependencies = {
      history: { readStrict: async () => ({ status: "FAILED" as const }) },
      historyPath: "/data/reviews.jsonl",
      statOf: () => ({ size: 10, mtimeMs: 1 }),
      sleep: async (ms: number) => {
        clock.now += ms;
      },
      monotonicNow: () => clock.now,
    };

    expect(await waitForReview(dependencies, CLOSED.turnId, 200)).toBeNull();
  });
});
