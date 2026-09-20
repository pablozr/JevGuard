import type {
  BuiltInReviewResult,
  ReviewCounts,
  ReviewLevelResult,
  ReviewResult,
  RuleReviewResult,
  SemanticVerdict,
  SkippedReason,
  TurnReview,
  UnavailableReason,
} from "@jevguard/core";
import { aggregateReview } from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  createOpenCodeLogSink,
  createOpenCodeToastSink,
  createReviewPresenter,
  displayOutcome,
  logLevelFor,
  toReviewLogEntry,
  toReviewToast,
} from "../src/index";
import type {
  DeliveryStatus,
  OpenCodeLogInput,
  OpenCodeLogResult,
  OpenCodePresentationClient,
  OpenCodeToastInput,
  OpenCodeToastResult,
  ReviewLogEntry,
  StructuredLogSink,
  ToastSink,
  ToastVariant,
} from "../src/index";

const TURN_ID = "turn-1";

function semanticResult(outcome: SemanticVerdict, probability: number): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: TURN_ID,
    ruleId: "ARCH-001",
    severity: "error",
    scopedPaths: ["src/a.ts", "src/b.ts"],
    outcome,
    violationProbability: probability,
  };
}

function skippedResult(reason: SkippedReason): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: TURN_ID,
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "SKIPPED",
    reason,
  };
}

function unavailableResult(reason: UnavailableReason): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: TURN_ID,
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

function reviewUnavailableResult(reason: UnavailableReason): ReviewLevelResult {
  return {
    kind: "REVIEW",
    turnId: TURN_ID,
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

function builtInResult(outcome: SemanticVerdict, probability: number): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: TURN_ID,
    ruleId: null,
    checkId: "SCOPE-CREEP",
    severity: "error",
    scopedPaths: ["src/a.ts", "src/b.ts"],
    outcome,
    violationProbability: probability,
  };
}

function builtInSkippedResult(): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: TURN_ID,
    ruleId: null,
    checkId: "SCOPE-CREEP",
    severity: "error",
    scopedPaths: [],
    outcome: "SKIPPED",
    reason: "NO_ATTRIBUTED_PATCH",
  };
}

function reviewOf(results: readonly ReviewResult[]): TurnReview {
  return aggregateReview(TURN_ID, results);
}

function counts(overrides: Partial<ReviewCounts> = {}): ReviewCounts {
  return { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0, ...overrides };
}

class FakeLogSink implements StructuredLogSink {
  result: DeliveryStatus = "DELIVERED";
  error: Error | null = null;
  readonly entries: ReviewLogEntry[] = [];

  constructor(private readonly order: string[] = []) {}

  async write(entry: ReviewLogEntry): Promise<DeliveryStatus> {
    this.entries.push(entry);
    this.order.push("log");

    if (this.error !== null) {
      throw this.error;
    }

    return this.result;
  }
}

class FakeToastSink implements ToastSink {
  result: DeliveryStatus = "DELIVERED";
  error: Error | null = null;
  readonly toasts: ReturnType<typeof toReviewToast>[] = [];

  constructor(private readonly order: string[] = []) {}

  async show(toast: ReturnType<typeof toReviewToast>): Promise<DeliveryStatus> {
    this.toasts.push(toast);
    this.order.push("toast");

    if (this.error !== null) {
      throw this.error;
    }

    return this.result;
  }
}

class FakeOpenCodeClient implements OpenCodePresentationClient {
  logResult: OpenCodeLogResult = {};
  toastResult: OpenCodeToastResult = {};
  logError: Error | null = null;
  toastError: Error | null = null;
  readonly logCalls: OpenCodeLogInput[] = [];
  readonly toastCalls: OpenCodeToastInput[] = [];

  readonly app = {
    log: (input: OpenCodeLogInput): Promise<OpenCodeLogResult> => {
      this.logCalls.push(input);

      if (this.logError !== null) {
        return Promise.reject(this.logError);
      }

      return Promise.resolve(this.logResult);
    },
  };

  readonly tui = {
    showToast: (input: OpenCodeToastInput): Promise<OpenCodeToastResult> => {
      this.toastCalls.push(input);

      if (this.toastError !== null) {
        return Promise.reject(this.toastError);
      }

      return Promise.resolve(this.toastResult);
    },
  };
}

const mixedResults = (): RuleReviewResult[] => [
  semanticResult("FAIL", 0.91),
  semanticResult("WARN", 0.4),
  unavailableResult("JEV_FAILURE"),
  skippedResult("NO_SCOPE_MATCH"),
];

describe("aggregate log mapping", () => {
  test("projects the aggregate summary and nested results exactly", () => {
    const entry = toReviewLogEntry(reviewOf(mixedResults()));

    expect(entry).toEqual({
      turnId: TURN_ID,
      summary: {
        highestVerdict: "FAIL",
        hasUnavailable: true,
        counts: { pass: 0, warn: 1, fail: 1, skipped: 1, unavailable: 1 },
      },
      results: [
        {
          kind: "RULE",
          ruleId: "ARCH-001",
          severity: "error",
          scopedPaths: ["src/a.ts", "src/b.ts"],
          outcome: "FAIL",
          violationProbability: 0.91,
        },
        {
          kind: "RULE",
          ruleId: "ARCH-001",
          severity: "error",
          scopedPaths: ["src/a.ts", "src/b.ts"],
          outcome: "WARN",
          violationProbability: 0.4,
        },
        {
          kind: "RULE",
          ruleId: null,
          severity: null,
          scopedPaths: [],
          outcome: "UNAVAILABLE",
          reason: "JEV_FAILURE",
        },
        {
          kind: "RULE",
          ruleId: null,
          severity: null,
          scopedPaths: [],
          outcome: "SKIPPED",
          reason: "NO_SCOPE_MATCH",
        },
      ],
    });
  });

  test("distinguishes RULE, BUILT_IN, and REVIEW kinds with the correct identity", () => {
    const entry = toReviewLogEntry(
      reviewOf([
        semanticResult("FAIL", 0.91),
        builtInResult("WARN", 0.5),
        builtInSkippedResult(),
        reviewUnavailableResult("INVALID_CONFIG"),
      ]),
    );

    expect(entry.results).toEqual([
      {
        kind: "RULE",
        ruleId: "ARCH-001",
        severity: "error",
        scopedPaths: ["src/a.ts", "src/b.ts"],
        outcome: "FAIL",
        violationProbability: 0.91,
      },
      {
        kind: "BUILT_IN",
        checkId: "SCOPE-CREEP",
        severity: "error",
        scopedPaths: ["src/a.ts", "src/b.ts"],
        outcome: "WARN",
        violationProbability: 0.5,
      },
      {
        kind: "BUILT_IN",
        checkId: "SCOPE-CREEP",
        severity: "error",
        scopedPaths: [],
        outcome: "SKIPPED",
        reason: "NO_ATTRIBUTED_PATCH",
      },
      {
        kind: "REVIEW",
        outcome: "UNAVAILABLE",
        reason: "INVALID_CONFIG",
      },
    ]);
  });

  test("records semantic counts as zero when no rule reached that verdict", () => {
    const entry = toReviewLogEntry(reviewOf([skippedResult("NO_ATTRIBUTED_PATCH")]));

    expect(entry.summary.counts).toEqual({
      pass: 0,
      warn: 0,
      fail: 0,
      skipped: 1,
      unavailable: 0,
    });
    expect(entry.summary.highestVerdict).toBeNull();
    expect(entry.summary.hasUnavailable).toBe(false);
  });

  test("keeps exactly the nested allowlist and leaks no task, prose, diff, or key material", () => {
    const entry = toReviewLogEntry(reviewOf(mixedResults()));

    expect(Object.keys(entry).sort()).toEqual(["results", "summary", "turnId"]);
    expect(Object.keys(entry.summary).sort()).toEqual([
      "counts",
      "hasUnavailable",
      "highestVerdict",
    ]);
    expect(Object.keys(entry.summary.counts).sort()).toEqual([
      "fail",
      "pass",
      "skipped",
      "unavailable",
      "warn",
    ]);

    for (const result of entry.results) {
      if (result.outcome === "PASS" || result.outcome === "WARN" || result.outcome === "FAIL") {
        expect(Object.keys(result).sort()).toEqual([
          "kind",
          "outcome",
          "ruleId",
          "scopedPaths",
          "severity",
          "violationProbability",
        ]);
      } else {
        expect(Object.keys(result).sort()).toEqual([
          "kind",
          "outcome",
          "reason",
          "ruleId",
          "scopedPaths",
          "severity",
        ]);
      }
    }

    const kindEntry = toReviewLogEntry(
      reviewOf([builtInResult("PASS", 0.1), reviewUnavailableResult("INVALID_CONFIG")]),
    );

    expect(Object.keys(kindEntry.results[0] ?? {}).sort()).toEqual([
      "checkId",
      "kind",
      "outcome",
      "scopedPaths",
      "severity",
      "violationProbability",
    ]);
    expect(Object.keys(kindEntry.results[1] ?? {}).sort()).toEqual(["kind", "outcome", "reason"]);

    const serialized = JSON.stringify(entry);
    expect(serialized).not.toMatch(/task|description|diff|api[-_]?key|typesafe|token|secret/i);
  });
});

describe("display outcome precedence", () => {
  test("resolves FAIL over UNAVAILABLE and all lower outcomes", () => {
    expect(displayOutcome(counts({ fail: 1, unavailable: 2, warn: 3 }))).toBe("FAIL");
  });

  test("resolves UNAVAILABLE over WARN and PASS", () => {
    expect(displayOutcome(counts({ unavailable: 1, warn: 2, pass: 3 }))).toBe("UNAVAILABLE");
  });

  test("resolves WARN over PASS and SKIPPED", () => {
    expect(displayOutcome(counts({ warn: 1, pass: 2, skipped: 3 }))).toBe("WARN");
  });

  test("resolves PASS over SKIPPED", () => {
    expect(displayOutcome(counts({ pass: 1, skipped: 2 }))).toBe("PASS");
  });

  test("resolves SKIPPED when every result is operational", () => {
    expect(displayOutcome(counts({ skipped: 2 }))).toBe("SKIPPED");
  });

  test.each<[RuleReviewResult[], string]>([
    [[semanticResult("FAIL", 0.9), unavailableResult("JEV_FAILURE")], "FAIL"],
    [[semanticResult("WARN", 0.4), unavailableResult("JEV_FAILURE")], "UNAVAILABLE"],
    [[semanticResult("PASS", 0.1), skippedResult("NO_SCOPE_MATCH")], "PASS"],
    [[skippedResult("NO_SCOPE_MATCH"), skippedResult("NO_ATTRIBUTED_PATCH")], "SKIPPED"],
  ])("titles the aggregate toast with the display outcome %#", (results, display) => {
    expect(toReviewToast(reviewOf(results)).title).toBe(`JevGuard ${display}`);
  });
});

describe("aggregate toast mapping", () => {
  test("summarizes counts only, never probabilities, paths, or evidence", () => {
    const toast = toReviewToast(reviewOf(mixedResults()));

    expect(toast).toEqual({
      title: "JevGuard FAIL",
      message: "pass 0 · warn 1 · fail 1 · skipped 1 · unavailable 1",
      variant: "error",
    });
    expect(toast.message).not.toMatch(/0\.91|0\.4|src\/a\.ts|src\/b\.ts/);
  });

  test.each<[ReviewCounts, ToastVariant]>([
    [counts({ fail: 1 }), "error"],
    [counts({ unavailable: 1 }), "error"],
    [counts({ warn: 1 }), "warning"],
    [counts({ pass: 1 }), "success"],
    [counts({ skipped: 1 }), "info"],
  ])("maps %# to the expected variant", (summaryCounts, variant) => {
    const results: RuleReviewResult[] = [];

    if (summaryCounts.fail > 0) results.push(semanticResult("FAIL", 0.9));
    if (summaryCounts.unavailable > 0) results.push(unavailableResult("JEV_FAILURE"));
    if (summaryCounts.warn > 0) results.push(semanticResult("WARN", 0.5));
    if (summaryCounts.pass > 0) results.push(semanticResult("PASS", 0.1));
    if (summaryCounts.skipped > 0) results.push(skippedResult("NO_SCOPE_MATCH"));

    expect(toReviewToast(reviewOf(results)).variant).toBe(variant);
  });

  test("shows zero-valued semantic counts in the message", () => {
    expect(toReviewToast(reviewOf([skippedResult("NO_ATTRIBUTED_PATCH")])).message).toBe(
      "pass 0 · warn 0 · fail 0 · skipped 1 · unavailable 0",
    );
  });
});

describe("log levels", () => {
  test.each<["PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE", "info" | "warn" | "error"]>([
    ["PASS", "info"],
    ["SKIPPED", "info"],
    ["WARN", "warn"],
    ["FAIL", "error"],
    ["UNAVAILABLE", "error"],
  ])("maps %s to the %s level", (outcome, level) => {
    expect(logLevelFor(outcome)).toBe(level);
  });
});

describe("review presenter", () => {
  test("delivers exactly one log and one toast per aggregate review, log first", async () => {
    const order: string[] = [];
    const log = new FakeLogSink(order);
    const toast = new FakeToastSink(order);

    const delivery = await createReviewPresenter({ log, toast }).present(reviewOf(mixedResults()));

    expect(delivery).toEqual({ log: "DELIVERED", toast: "DELIVERED" });
    expect(log.entries).toHaveLength(1);
    expect(toast.toasts).toHaveLength(1);
    expect(order).toEqual(["log", "toast"]);
  });

  test("isolates a log failure from the toast delivery", async () => {
    const log = new FakeLogSink();
    log.error = new Error("log backend down");
    const toast = new FakeToastSink();

    const delivery = await createReviewPresenter({ log, toast }).present(
      reviewOf([semanticResult("PASS", 0.1)]),
    );

    expect(delivery).toEqual({ log: "FAILED", toast: "DELIVERED" });
    expect(toast.toasts).toHaveLength(1);
  });

  test("isolates a toast failure from the log delivery", async () => {
    const log = new FakeLogSink();
    const toast = new FakeToastSink();
    toast.error = new Error("toast backend down");

    const delivery = await createReviewPresenter({ log, toast }).present(
      reviewOf([semanticResult("PASS", 0.1)]),
    );

    expect(delivery).toEqual({ log: "DELIVERED", toast: "FAILED" });
    expect(log.entries).toHaveLength(1);
  });

  test("propagates typed sink failures without throwing", async () => {
    const log = new FakeLogSink();
    log.result = "FAILED";
    const toast = new FakeToastSink();
    toast.result = "FAILED";

    await expect(
      createReviewPresenter({ log, toast }).present(reviewOf([semanticResult("WARN", 0.5)])),
    ).resolves.toEqual({ log: "FAILED", toast: "FAILED" });
  });
});

describe("OpenCode sinks", () => {
  test("sends the exact aggregate extra and level for a mixed review", async () => {
    const client = new FakeOpenCodeClient();
    const sink = createOpenCodeLogSink(client);

    const status = await sink.write(toReviewLogEntry(reviewOf(mixedResults())));

    expect(status).toBe("DELIVERED");
    expect(client.logCalls).toHaveLength(1);
    expect(client.logCalls[0]?.body).toEqual({
      service: "jevguard",
      level: "error",
      message: `JevGuard FAIL for turn ${TURN_ID}`,
      extra: {
        turnId: TURN_ID,
        summary: {
          highestVerdict: "FAIL",
          hasUnavailable: true,
          counts: { pass: 0, warn: 1, fail: 1, skipped: 1, unavailable: 1 },
        },
        results: [
          {
            kind: "RULE",
            ruleId: "ARCH-001",
            severity: "error",
            scopedPaths: ["src/a.ts", "src/b.ts"],
            outcome: "FAIL",
            violationProbability: 0.91,
          },
          {
            kind: "RULE",
            ruleId: "ARCH-001",
            severity: "error",
            scopedPaths: ["src/a.ts", "src/b.ts"],
            outcome: "WARN",
            violationProbability: 0.4,
          },
          {
            kind: "RULE",
            ruleId: null,
            severity: null,
            scopedPaths: [],
            outcome: "UNAVAILABLE",
            reason: "JEV_FAILURE",
          },
          {
            kind: "RULE",
            ruleId: null,
            severity: null,
            scopedPaths: [],
            outcome: "SKIPPED",
            reason: "NO_SCOPE_MATCH",
          },
        ],
      },
    });
  });

  test("sends kind and check identity for a built-in result", async () => {
    const client = new FakeOpenCodeClient();
    const sink = createOpenCodeLogSink(client);

    await sink.write(toReviewLogEntry(reviewOf([builtInResult("PASS", 0.2)])));

    expect(client.logCalls[0]?.body.extra).toEqual({
      turnId: TURN_ID,
      summary: {
        highestVerdict: "PASS",
        hasUnavailable: false,
        counts: { pass: 1, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
      },
      results: [
        {
          kind: "BUILT_IN",
          checkId: "SCOPE-CREEP",
          severity: "error",
          scopedPaths: ["src/a.ts", "src/b.ts"],
          outcome: "PASS",
          violationProbability: 0.2,
        },
      ],
    });
  });

  test("sends only kind and outcome for a review-level result", async () => {
    const client = new FakeOpenCodeClient();
    const sink = createOpenCodeLogSink(client);

    await sink.write(toReviewLogEntry(reviewOf([reviewUnavailableResult("INVALID_RULE")])));

    expect(client.logCalls[0]?.body.extra).toEqual({
      turnId: TURN_ID,
      summary: {
        highestVerdict: null,
        hasUnavailable: true,
        counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
      },
      results: [{ kind: "REVIEW", outcome: "UNAVAILABLE", reason: "INVALID_RULE" }],
    });
  });

  test("logs UNAVAILABLE and SKIPPED at error and info levels", async () => {
    const client = new FakeOpenCodeClient();
    const sink = createOpenCodeLogSink(client);

    await sink.write(toReviewLogEntry(reviewOf([unavailableResult("JEV_FAILURE")])));
    await sink.write(toReviewLogEntry(reviewOf([skippedResult("NO_SCOPE_MATCH")])));

    expect(client.logCalls[0]?.body.level).toBe("error");
    expect(client.logCalls[1]?.body.level).toBe("info");
  });

  test("maps a log result error and a rejected log request to FAILED", async () => {
    const errored = new FakeOpenCodeClient();
    errored.logResult = { error: { message: "bad request" } };
    expect(
      await createOpenCodeLogSink(errored).write(toReviewLogEntry(reviewOf(mixedResults()))),
    ).toBe("FAILED");

    const rejected = new FakeOpenCodeClient();
    rejected.logError = new Error("connection reset");
    expect(
      await createOpenCodeLogSink(rejected).write(toReviewLogEntry(reviewOf(mixedResults()))),
    ).toBe("FAILED");
  });

  test("sends a transient toast and never a session message", async () => {
    const client = new FakeOpenCodeClient();
    const sink = createOpenCodeToastSink(client);

    const status = await sink.show(toReviewToast(reviewOf(mixedResults())));

    expect(status).toBe("DELIVERED");
    expect(client.toastCalls).toHaveLength(1);
    expect(client.toastCalls[0]?.body).toEqual({
      title: "JevGuard FAIL",
      message: "pass 0 · warn 1 · fail 1 · skipped 1 · unavailable 1",
      variant: "error",
      duration: 5000,
    });
    expect("session" in client).toBe(false);
  });

  test("maps a toast result error and a rejected toast request to FAILED", async () => {
    const errored = new FakeOpenCodeClient();
    errored.toastResult = { error: { message: "tui unavailable" } };
    expect(
      await createOpenCodeToastSink(errored).show(toReviewToast(reviewOf(mixedResults()))),
    ).toBe("FAILED");

    const rejected = new FakeOpenCodeClient();
    rejected.toastError = new Error("connection reset");
    expect(
      await createOpenCodeToastSink(rejected).show(toReviewToast(reviewOf(mixedResults()))),
    ).toBe("FAILED");
  });
});
