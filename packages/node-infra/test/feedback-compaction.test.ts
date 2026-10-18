import {
  aggregateReviewHistory,
  type FeedbackDecision,
  type FeedbackRecord,
  failIdentityKey,
  latestDecisions,
  listPendingFails,
  planFeedbackDecision,
  type ReportRecord,
  type ReportResult,
} from "@jevguard/core";
import { describe, expect, test } from "vitest";
import { resolveFeedbackFilePath } from "../src/feedback";
import { compactFeedbackFile, compactFeedbackRecords } from "../src/feedback/compact";
import { DEFAULT_FEEDBACK_MAX_RECORDS } from "../src/feedback/local";
import { createLocalFeedbackStore } from "../src/index";
import { context, FakeHistoryFileSystem } from "./support/history-fakes";

const MAX_RECORDS = DEFAULT_FEEDBACK_MAX_RECORDS;

function entry(
  turnId: string,
  decision: FeedbackDecision = "WRONG",
  timestamp = "2026-01-01T00:00:00.000Z",
  ruleId = "no-eval",
): FeedbackRecord {
  return { turnId, ruleId, decision, timestamp };
}

function distinct(count: number): FeedbackRecord[] {
  return Array.from({ length: count }, (_unused, index) => entry(`t${index}`));
}

function failResult(ruleId: string): ReportResult {
  return { kind: "RULE", ruleId, outcome: "FAIL", violationProbability: 0.9 };
}

function reportRecord(turnId: string, timestamp: string, rules: readonly string[]): ReportRecord {
  return {
    timestamp,
    turnId,
    summary: {
      highestVerdict: "FAIL",
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: rules.length, skipped: 0, unavailable: 0 },
    },
    results: rules.map(failResult),
  };
}

function lines(records: readonly FeedbackRecord[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

const filePath = resolveFeedbackFilePath(context({ xdg: "/data" }));

describe("compactFeedbackRecords", () => {
  test("keeps exactly maxRecords distinct identities unchanged", () => {
    const input = distinct(MAX_RECORDS);

    expect(compactFeedbackRecords(input, MAX_RECORDS)).toEqual(input);
  });

  test("drops the oldest identity past maxRecords", () => {
    const input = distinct(MAX_RECORDS + 1);

    expect(compactFeedbackRecords(input, MAX_RECORDS)).toEqual(input.slice(1));
  });

  test("keeps every identity when 5001 lines repeat one identity", () => {
    const input = [...distinct(MAX_RECORDS), entry("t0", "RIGHT", "2026-02-01T00:00:00.000Z")];
    const result = compactFeedbackRecords(input, MAX_RECORDS);

    expect(result).toHaveLength(MAX_RECORDS);
    expect(result.at(-1)).toEqual(entry("t0", "RIGHT", "2026-02-01T00:00:00.000Z"));
    expect(result[0]).toEqual(entry("t1"));
  });

  test("collapses a round trip to the last record", () => {
    const last = entry("t1", "RIGHT", "2026-03-01T00:00:00.000Z");
    const result = compactFeedbackRecords(
      [entry("t1", "RIGHT"), entry("t1", "WRONG", "2026-02-01T00:00:00.000Z"), last],
      MAX_RECORDS,
    );

    expect(result).toEqual([last]);
  });

  test("returns an empty list for an empty input", () => {
    expect(compactFeedbackRecords([], MAX_RECORDS)).toEqual([]);
  });
});

describe("compaction equivalence", () => {
  const history = [
    reportRecord("t1", "2026-01-01T00:00:00.000Z", ["R-1", "R-2"]),
    reportRecord("t2", "2026-01-02T00:00:00.000Z", ["R-1"]),
    reportRecord("t3", "2026-01-03T00:00:00.000Z", ["R-2", "R-3"]),
    reportRecord("t4", "2026-01-04T00:00:00.000Z", ["R-3"]),
  ];
  const feedback = [
    entry("t1", "WRONG", "2026-02-01T00:00:00.000Z", "R-1"),
    entry("t1", "RIGHT", "2026-02-02T00:00:00.000Z", "R-1"),
    entry("t2", "WRONG", "2026-02-03T00:00:00.000Z", "R-1"),
    entry("t3", "RIGHT", "2026-02-04T00:00:00.000Z", "R-2"),
    entry("gone", "RIGHT", "2026-02-05T00:00:00.000Z", "R-9"),
    entry("t3", "WRONG", "2026-02-06T00:00:00.000Z", "R-2"),
    entry("t1", "WRONG", "2026-02-07T00:00:00.000Z", "R-1"),
  ];
  const compacted = compactFeedbackRecords(feedback, MAX_RECORDS);

  test("keeps the latest decisions while shrinking the feedback", () => {
    expect(compacted.length).toBeLessThan(feedback.length);
    expect(latestDecisions(compacted)).toEqual(latestDecisions(feedback));
  });

  test("calibration is identical", () => {
    expect(aggregateReviewHistory(history, 0, compacted).rules).toEqual(
      aggregateReviewHistory(history, 0, feedback).rules,
    );
  });

  test("pending list is identical", () => {
    expect(listPendingFails(history, compacted, 20)).toEqual(
      listPendingFails(history, feedback, 20),
    );
  });

  test("decision planning is identical", () => {
    const targets = [
      { turnId: "t1", ruleId: "R-1" },
      { turnId: "t2", ruleId: "R-1" },
      { turnId: "t4", ruleId: "R-3" },
    ];

    for (const target of targets) {
      for (const decision of ["RIGHT", "WRONG"] as const) {
        expect(planFeedbackDecision(target, decision, compacted)).toEqual(
          planFeedbackDecision(target, decision, feedback),
        );
      }
    }
  });
});

describe("compactFeedbackFile", () => {
  test("does not write at or below maxBytes", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const contents = lines([entry("t1"), entry("t1", "RIGHT")]);

    fileSystem.files.set(filePath, contents);
    await compactFeedbackFile(fileSystem, filePath, Buffer.byteLength(contents), MAX_RECORDS);

    expect(fileSystem.atomicWrites).toEqual([]);
    expect(fileSystem.files.get(filePath)).toBe(contents);
  });

  test("rewrites deduplicated above maxBytes", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.files.set(filePath, lines([entry("t1"), entry("t2"), entry("t1", "RIGHT")]));
    await compactFeedbackFile(fileSystem, filePath, 10, MAX_RECORDS);

    expect(fileSystem.files.get(filePath)).toBe(lines([entry("t2"), entry("t1", "RIGHT")]));
  });

  test("drops malformed lines and keeps valid records", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.files.set(filePath, `{not json\n${lines([entry("t1")])}garbage\n`);
    await compactFeedbackFile(fileSystem, filePath, 10, MAX_RECORDS);

    expect(fileSystem.files.get(filePath)).toBe(lines([entry("t1")]));
  });

  test("leaves a file with only unparseable lines intact", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const garbage = '{not json\n{"future":true}\n';

    fileSystem.files.set(filePath, garbage);
    await compactFeedbackFile(fileSystem, filePath, 1, MAX_RECORDS);

    expect(fileSystem.files.get(filePath)).toBe(garbage);
    expect(fileSystem.atomicWrites).toEqual([]);
  });

  test("resolves without rejecting when reading fails", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.files.set(filePath, lines([entry("t1")]));
    fileSystem.failRead = true;

    await expect(
      compactFeedbackFile(fileSystem, filePath, 1, MAX_RECORDS),
    ).resolves.toBeUndefined();
  });

  test("keeps append WRITTEN when the rewrite fails", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const store = createLocalFeedbackStore({
      context: context({ xdg: "/data" }),
      fileSystem,
      maxBytes: 1,
    });

    fileSystem.writeFileAtomic = async () => {
      throw new Error("write failed");
    };

    await expect(store.append(entry("t1"))).resolves.toBe("WRITTEN");
    await expect(store.append(entry("t1", "RIGHT"))).resolves.toBe("WRITTEN");
  });

  test("compacts a current-format file that is then re-read without skipped lines", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const store = createLocalFeedbackStore({ context: context({ xdg: "/data" }), fileSystem });

    fileSystem.files.set(filePath, lines([entry("t1"), entry("t1", "RIGHT")]));
    await compactFeedbackFile(fileSystem, filePath, 1, MAX_RECORDS);

    await expect(store.read()).resolves.toEqual({
      status: "READ",
      records: [entry("t1", "RIGHT")],
      skippedLineCount: 0,
    });
  });

  test("writes only the four allowlisted keys per line", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const polluted = { ...entry("t1"), task: "secret task" } as FeedbackRecord;
    const compacted = compactFeedbackRecords([polluted, entry("t2")], MAX_RECORDS);

    fileSystem.files.set(filePath, lines(compacted).repeat(2));
    await compactFeedbackFile(fileSystem, filePath, 1, MAX_RECORDS);

    const written = fileSystem.files.get(filePath) ?? "";

    expect(written).not.toContain("secret task");

    for (const line of written.trim().split("\n")) {
      expect(Object.keys(JSON.parse(line))).toEqual(["turnId", "ruleId", "decision", "timestamp"]);
    }
  });
});

describe("regression: duplicate answers must not push distinct identities out", () => {
  test("keeps every distinct identity after repeated answers", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const store = createLocalFeedbackStore({
      context: context({ xdg: "/data" }),
      fileSystem,
      maxBytes: 1,
      maxRecords: MAX_RECORDS,
    });
    const repeats = Array.from({ length: 9 }, () => entry("t4999", "RIGHT"));

    fileSystem.files.set(filePath, lines([...distinct(MAX_RECORDS), ...repeats]));
    await store.append(entry("t4999", "WRONG", "2026-02-01T00:00:00.000Z"));

    const result = await store.read();

    expect(result.status).toBe("READ");

    if (result.status !== "READ") {
      return;
    }

    const decisions = latestDecisions(result.records);

    expect(result.records).toHaveLength(MAX_RECORDS);
    expect(decisions.get(failIdentityKey({ turnId: "t0", ruleId: "no-eval" }))).toBe("WRONG");
    expect(decisions.get(failIdentityKey({ turnId: "t4999", ruleId: "no-eval" }))).toBe("WRONG");
  });
});
