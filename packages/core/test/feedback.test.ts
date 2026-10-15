import { describe, expect, test } from "vitest";
import {
  collectRuleFails,
  failIdentityKey,
  FEEDBACK_LIST_LIMIT,
  latestDecisions,
  listPendingFails,
  planFeedbackDecision,
  resolveFeedbackTarget,
} from "../src/index";
import type {
  FeedbackDecision,
  FeedbackRecord,
  FeedbackSelection,
  ReportRecord,
  ReportResult,
} from "../src/index";

function record(timestamp: string, turnId: string, results: readonly ReportResult[]): ReportRecord {
  return {
    timestamp,
    turnId,
    summary: {
      highestVerdict: null,
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
    },
    results,
  };
}

function fail(ruleId: string | null, probability = 0.9): ReportResult {
  return { kind: "RULE", ruleId, outcome: "FAIL", violationProbability: probability };
}

function answer(turnId: string, ruleId: string, decision: FeedbackDecision): FeedbackRecord {
  return { turnId, ruleId, decision, timestamp: "2026-02-01T00:00:00.000Z" };
}

function selectionOf(...items: readonly { turnId: string; ruleId: string }[]): FeedbackSelection {
  return { version: 1, listedAt: "2026-02-01T00:00:00.000Z", items };
}

describe("listPendingFails", () => {
  test("ignores every result that is not a repository-rule FAIL", () => {
    const records = [
      record("2026-01-01T00:00:00.000Z", "t1", [
        { kind: "RULE", ruleId: "A", outcome: "PASS", violationProbability: 0.1 },
        { kind: "RULE", ruleId: "A", outcome: "WARN", violationProbability: 0.5 },
        { kind: "RULE", ruleId: "A", outcome: "UNAVAILABLE", reason: "JEV_FAILURE" },
        { kind: "RULE", ruleId: "A", outcome: "SKIPPED", reason: "NO_SCOPE_MATCH" },
        { kind: "BUILT_IN", checkId: "SCOPE-CREEP", outcome: "FAIL", violationProbability: 0.9 },
        fail(null),
      ]),
    ];

    expect(listPendingFails(records, [], FEEDBACK_LIST_LIMIT)).toEqual({ items: [], total: 0 });
  });

  test("sorts newest first with deterministic tie-breaks", () => {
    const records = [
      record("2026-01-01T00:00:00.000Z", "t1", [fail("A")]),
      record("2026-01-02T00:00:00.000Z", "t3", [fail("B"), fail("A")]),
      record("2026-01-02T00:00:00.000Z", "t2", [fail("A")]),
    ];

    const pending = listPendingFails(records, [], 20);

    expect(pending.items.map((item) => `${item.turnId}/${item.ruleId}`)).toEqual([
      "t2/A",
      "t3/A",
      "t3/B",
      "t1/A",
    ]);
  });

  test("deduplicates by identity keeping the newest timestamp and probability", () => {
    const records = [
      record("2026-01-02T00:00:00.000Z", "t1", [fail("A", 0.95)]),
      record("2026-01-01T00:00:00.000Z", "t1", [fail("A", 0.8)]),
    ];

    expect(listPendingFails(records, [], 20).items).toEqual([
      {
        turnId: "t1",
        ruleId: "A",
        timestamp: "2026-01-02T00:00:00.000Z",
        violationProbability: 0.95,
      },
    ]);
  });

  test("excludes answered FAILs", () => {
    const records = [
      record("2026-01-01T00:00:00.000Z", "t1", [fail("A")]),
      record("2026-01-02T00:00:00.000Z", "t2", [fail("A")]),
    ];

    const pending = listPendingFails(records, [answer("t1", "A", "WRONG")], 20);

    expect(pending.items.map((item) => item.turnId)).toEqual(["t2"]);
    expect(pending.total).toBe(1);
  });

  test("cuts items to the limit while total stays complete", () => {
    const records = [
      record("2026-01-01T00:00:00.000Z", "t1", [fail("A")]),
      record("2026-01-02T00:00:00.000Z", "t2", [fail("A")]),
      record("2026-01-03T00:00:00.000Z", "t3", [fail("A")]),
    ];

    const pending = listPendingFails(records, [], 2);

    expect(pending.items).toHaveLength(2);
    expect(pending.total).toBe(3);
  });

  test("returns an empty list for an empty history", () => {
    expect(listPendingFails([], [], 20)).toEqual({ items: [], total: 0 });
  });
});

describe("latestDecisions", () => {
  test("lets the last record win", () => {
    const decisions = latestDecisions([answer("t1", "A", "RIGHT"), answer("t1", "A", "WRONG")]);

    expect(decisions.get(failIdentityKey({ turnId: "t1", ruleId: "A" }))).toBe("WRONG");
  });
});

describe("failIdentityKey", () => {
  test("does not collide when identifiers contain separators", () => {
    const left = failIdentityKey({ turnId: "a:b", ruleId: "c" });
    const right = failIdentityKey({ turnId: "a", ruleId: "b:c" });

    expect(left).not.toBe(right);
  });
});

describe("resolveFeedbackTarget", () => {
  const records = [record("2026-01-01T00:00:00.000Z", "t1", [fail("A", 0.91)])];
  const selection = selectionOf({ turnId: "t1", ruleId: "A" });

  test("reports no selection", () => {
    expect(resolveFeedbackTarget(null, 1, records)).toEqual({ status: "NO_SELECTION" });
  });

  test("rejects zero, numbers past the list and an empty list", () => {
    expect(resolveFeedbackTarget(selection, 0, records).status).toBe("NUMBER_OUT_OF_RANGE");
    expect(resolveFeedbackTarget(selection, 2, records).status).toBe("NUMBER_OUT_OF_RANGE");
    expect(resolveFeedbackTarget(selectionOf(), 1, records).status).toBe("NUMBER_OUT_OF_RANGE");
  });

  test("reports an identity that left the history", () => {
    const stale = selectionOf({ turnId: "gone", ruleId: "A" });

    expect(resolveFeedbackTarget(stale, 1, records)).toEqual({ status: "NO_LONGER_IN_HISTORY" });
  });

  test("finds the FAIL with the data from the history", () => {
    expect(resolveFeedbackTarget(selection, 1, records)).toEqual({
      status: "FOUND",
      fail: {
        turnId: "t1",
        ruleId: "A",
        timestamp: "2026-01-01T00:00:00.000Z",
        violationProbability: 0.91,
      },
    });
  });

  test("keeps number 1 on the listed FAIL when a newer FAIL appears", () => {
    const grown = [record("2026-03-01T00:00:00.000Z", "t9", [fail("Z")]), ...records];
    const resolved = resolveFeedbackTarget(selection, 1, grown);

    expect(resolved.status === "FOUND" && resolved.fail.turnId).toBe("t1");
  });
});

describe("planFeedbackDecision", () => {
  const target = { turnId: "t1", ruleId: "A" };

  test("records a first answer", () => {
    expect(planFeedbackDecision(target, "WRONG", [])).toEqual({
      status: "RECORD",
      previous: null,
    });
  });

  test("leaves the same answer unchanged", () => {
    expect(planFeedbackDecision(target, "WRONG", [answer("t1", "A", "WRONG")])).toEqual({
      status: "UNCHANGED",
    });
  });

  test("records a different answer with the previous one", () => {
    expect(planFeedbackDecision(target, "RIGHT", [answer("t1", "A", "WRONG")])).toEqual({
      status: "RECORD",
      previous: "WRONG",
    });
  });
});

describe("collectRuleFails", () => {
  test("keys fails by identity", () => {
    const fails = collectRuleFails([record("2026-01-01T00:00:00.000Z", "t1", [fail("A")])]);

    expect([...fails.keys()]).toEqual([failIdentityKey({ turnId: "t1", ruleId: "A" })]);
  });
});
