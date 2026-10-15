import type { FeedbackRecord, FeedbackSelection } from "@jevguard/core";
import type {
  FeedbackReadResult,
  FeedbackSelectionReadResult,
  FeedbackWriteStatus,
  LocalFeedbackStore,
  ReviewHistoryRecord,
} from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import { parseFeedbackArguments } from "../src/cli/feedback/arguments";
import { listFeedback, markFeedback } from "../src/cli/feedback/execute";
import { describeAge, describeFeedbackMark } from "../src/cli/feedback/messages";
import type { FeedbackDependencies } from "../src/cli/feedback/types";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function failRecord(turnId: string, timestamp: string, ruleId = "ARCH-001"): ReviewHistoryRecord {
  return {
    timestamp,
    turnId,
    summary: {
      highestVerdict: "FAIL",
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 1, skipped: 0, unavailable: 0 },
    },
    results: [
      {
        kind: "RULE",
        ruleId,
        severity: "error",
        scopedPaths: [],
        outcome: "FAIL",
        violationProbability: 0.9,
      },
    ],
  };
}

class FakeStore implements LocalFeedbackStore {
  records: FeedbackRecord[] = [];
  selection: FeedbackSelection | null = null;
  failRead = false;
  failWriteSelection = false;
  failAppend = false;

  async read(): Promise<FeedbackReadResult> {
    return this.failRead
      ? { status: "FAILED" }
      : { status: "READ", records: this.records, skippedLineCount: 0 };
  }

  async append(record: FeedbackRecord): Promise<FeedbackWriteStatus> {
    if (this.failAppend) {
      return "FAILED";
    }

    this.records.push(record);

    return "WRITTEN";
  }

  async readSelection(): Promise<FeedbackSelectionReadResult> {
    return { status: "READ", selection: this.selection };
  }

  async writeSelection(selection: FeedbackSelection): Promise<FeedbackWriteStatus> {
    if (this.failWriteSelection) {
      return "FAILED";
    }

    this.selection = selection;

    return "WRITTEN";
  }
}

function setup(records: ReviewHistoryRecord[]): {
  store: FakeStore;
  history: ReviewHistoryRecord[];
  deps: FeedbackDependencies;
  failHistoryRead: () => void;
} {
  const store = new FakeStore();
  const history = records;
  let historyReadable = true;
  const deps: FeedbackDependencies = {
    history: {
      readStrict: async () =>
        historyReadable
          ? { status: "READ", records: history, skippedLineCount: 0 }
          : { status: "FAILED" },
    },
    store,
    now: () => NOW,
  };

  return {
    store,
    history,
    deps,
    failHistoryRead: () => {
      historyReadable = false;
    },
  };
}

const OLDER = failRecord("t1", "2026-02-28T00:00:00.000Z");
const NEWER = failRecord("t2", "2026-02-28T06:00:00.000Z", "ARCH-002");

describe("listFeedback", () => {
  test("pins the selection in the displayed order", async () => {
    const { store, deps } = setup([OLDER, NEWER]);

    const result = await listFeedback(deps);

    expect(result.status === "LISTED" && result.items.map((item) => item.number)).toEqual([1, 2]);
    expect(store.selection?.items).toEqual([
      { turnId: "t2", ruleId: "ARCH-002" },
      { turnId: "t1", ruleId: "ARCH-001" },
    ]);
  });

  test("writes an empty selection for an empty list", async () => {
    const { store, deps } = setup([]);
    store.selection = { version: 1, listedAt: "x", items: [{ turnId: "t1", ruleId: "A" }] };

    await listFeedback(deps);

    expect(store.selection?.items).toEqual([]);
  });

  test("does not show answered FAILs on a later listing", async () => {
    const { deps } = setup([OLDER, NEWER]);

    await listFeedback(deps);
    await markFeedback({ number: 1, decision: "WRONG" }, deps);
    const second = await listFeedback(deps);

    expect(second.status === "LISTED" && second.items.map((item) => item.turnId)).toEqual(["t1"]);
  });

  test("reports a selection write failure", async () => {
    const { store, deps } = setup([OLDER]);
    store.failWriteSelection = true;

    await expect(listFeedback(deps)).resolves.toEqual({ status: "WRITE_FAILED" });
  });

  test("reports an unreadable history without touching the selection", async () => {
    const { store, deps, failHistoryRead } = setup([OLDER]);
    store.selection = { version: 1, listedAt: "x", items: [{ turnId: "t1", ruleId: "A" }] };
    failHistoryRead();

    await expect(listFeedback(deps)).resolves.toEqual({ status: "READ_FAILED" });
    expect(store.selection?.items).toEqual([{ turnId: "t1", ruleId: "A" }]);
  });

  test("reports a feedback read failure", async () => {
    const { store, deps } = setup([OLDER]);
    store.failRead = true;

    await expect(listFeedback(deps)).resolves.toEqual({ status: "READ_FAILED" });
  });
});

describe("markFeedback", () => {
  test("keeps the listed number on its FAIL when a newer FAIL appears", async () => {
    const { store, history, deps } = setup([OLDER]);

    await listFeedback(deps);
    history.unshift(failRecord("t9", "2026-02-28T20:00:00.000Z", "ARCH-009"));
    const result = await markFeedback({ number: 1, decision: "WRONG" }, deps);

    expect(result).toMatchObject({ status: "RECORDED", ruleId: "ARCH-001" });
    expect(store.records[0]).toMatchObject({ turnId: "t1", ruleId: "ARCH-001" });
  });

  test("answers several numbers from the same listing", async () => {
    const { store, deps } = setup([OLDER, NEWER]);

    await listFeedback(deps);
    await markFeedback({ number: 1, decision: "WRONG" }, deps);
    await markFeedback({ number: 2, decision: "RIGHT" }, deps);

    expect(store.records.map((record) => [record.turnId, record.decision])).toEqual([
      ["t2", "WRONG"],
      ["t1", "RIGHT"],
    ]);
  });

  test("does not write when the decision is unchanged", async () => {
    const { store, deps } = setup([OLDER]);

    await listFeedback(deps);
    await markFeedback({ number: 1, decision: "WRONG" }, deps);
    const again = await markFeedback({ number: 1, decision: "WRONG" }, deps);

    expect(again).toEqual({
      status: "UNCHANGED",
      ruleId: "ARCH-001",
      decision: "WRONG",
      timestamp: OLDER.timestamp,
      violationProbability: 0.9,
    });
    expect(store.records).toHaveLength(1);
  });

  test("records a changed decision with the previous one", async () => {
    const { store, deps } = setup([OLDER]);

    await listFeedback(deps);
    await markFeedback({ number: 1, decision: "WRONG" }, deps);
    const changed = await markFeedback({ number: 1, decision: "RIGHT" }, deps);

    expect(changed).toEqual({
      status: "RECORDED",
      ruleId: "ARCH-001",
      decision: "RIGHT",
      previous: "WRONG",
      timestamp: OLDER.timestamp,
      violationProbability: 0.9,
    });
    expect(store.records).toHaveLength(2);
  });

  test("writes exactly the allowlisted fields", async () => {
    const { store, deps } = setup([OLDER]);

    await listFeedback(deps);
    await markFeedback({ number: 1, decision: "RIGHT" }, deps);

    expect(Object.keys(store.records[0] ?? {}).sort()).toEqual([
      "decision",
      "ruleId",
      "timestamp",
      "turnId",
    ]);
  });

  test("refuses without a prior listing", async () => {
    const { deps } = setup([OLDER]);

    await expect(markFeedback({ number: 1, decision: "WRONG" }, deps)).resolves.toEqual({
      status: "NO_SELECTION",
    });
  });

  test("refuses a number outside the list", async () => {
    const { deps } = setup([OLDER]);

    await listFeedback(deps);

    await expect(markFeedback({ number: 2, decision: "WRONG" }, deps)).resolves.toEqual({
      status: "NUMBER_OUT_OF_RANGE",
    });
  });

  test("refuses an item that left the history without writing", async () => {
    const { store, history, deps } = setup([OLDER]);

    await listFeedback(deps);
    history.length = 0;
    const result = await markFeedback({ number: 1, decision: "WRONG" }, deps);

    expect(result).toEqual({ status: "NO_LONGER_IN_HISTORY" });
    expect(store.records).toEqual([]);
  });

  test("reports an unreadable history instead of a missing item", async () => {
    const { store, deps, failHistoryRead } = setup([OLDER]);

    await listFeedback(deps);
    failHistoryRead();

    await expect(markFeedback({ number: 1, decision: "WRONG" }, deps)).resolves.toEqual({
      status: "READ_FAILED",
    });
    expect(store.records).toEqual([]);
  });

  test("reports append and read failures", async () => {
    const { store, deps } = setup([OLDER]);

    await listFeedback(deps);
    store.failAppend = true;
    await expect(markFeedback({ number: 1, decision: "WRONG" }, deps)).resolves.toEqual({
      status: "WRITE_FAILED",
    });

    store.failRead = true;
    await expect(markFeedback({ number: 1, decision: "WRONG" }, deps)).resolves.toEqual({
      status: "READ_FAILED",
    });
  });
});

describe("describeAge", () => {
  const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000).toISOString();

  test.each([
    [59, "just now"],
    [60, "1 min ago"],
    [59 * 60, "59 min ago"],
    [60 * 60, "1 h ago"],
    [47 * 3600, "47 h ago"],
    [48 * 3600, "2 d ago"],
  ])("renders %i seconds as %s", (seconds, expected) => {
    expect(describeAge(ago(seconds), NOW)).toBe(expected);
  });

  test("treats an invalid or future timestamp as just now", () => {
    expect(describeAge("nope", NOW)).toBe("just now");
    expect(describeAge(ago(-3600), NOW)).toBe("just now");
  });
});

describe("parseFeedbackArguments", () => {
  test("parses the listing forms", () => {
    expect(parseFeedbackArguments([])).toEqual({ kind: "LIST", json: false });
    expect(parseFeedbackArguments(["--json"])).toEqual({ kind: "LIST", json: true });
  });

  test("parses an answer", () => {
    expect(parseFeedbackArguments(["3", "right"])).toEqual({
      kind: "MARK",
      request: { number: 3, decision: "RIGHT" },
    });
    expect(parseFeedbackArguments(["12", "wrong"])).toEqual({
      kind: "MARK",
      request: { number: 12, decision: "WRONG" },
    });
  });

  test("flags an unknown decision", () => {
    expect(parseFeedbackArguments(["1", "maybe"])).toEqual({ kind: "INVALID_DECISION" });
    expect(parseFeedbackArguments(["1", "WRONG"])).toEqual({ kind: "INVALID_DECISION" });
  });

  test.each([
    [["abc", "wrong"]],
    [["0", "wrong"]],
    [["01", "wrong"]],
    [["12345", "wrong"]],
    [["1"]],
    [["1", "wrong", "extra"]],
    [["--json", "extra"]],
  ])("rejects %j as usage", (args) => {
    expect(parseFeedbackArguments(args)).toEqual({ kind: "USAGE" });
  });
});

describe("describeFeedbackMark", () => {
  const base = {
    ruleId: "no-console",
    timestamp: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(),
    violationProbability: 0.91,
  } as const;

  test("names the rule, age, and probability of the FAIL", () => {
    expect(
      describeFeedbackMark({ status: "RECORDED", ...base, decision: "WRONG", previous: null }, NOW),
    ).toBe("Marked as a false alarm: no-console (3 h ago, p=0.91).");
    expect(describeFeedbackMark({ status: "UNCHANGED", ...base, decision: "WRONG" }, NOW)).toBe(
      "Already marked as a false alarm: no-console (3 h ago, p=0.91).",
    );
    expect(
      describeFeedbackMark(
        { status: "RECORDED", ...base, decision: "WRONG", previous: "RIGHT" },
        NOW,
      ),
    ).toBe("Changed to a false alarm: no-console (3 h ago, p=0.91) (was a real violation).");
  });
});
