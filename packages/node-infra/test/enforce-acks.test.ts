import { describe, expect, test } from "vitest";
import {
  createLocalEnforceAckStore,
  isAcknowledged,
  isAckRecord,
  MAX_ACK_FIELD_LENGTH,
  MAX_ACK_RULE_IDS,
  resolveEnforceAcksFilePath,
} from "../src/enforce";
import type { LocalEnforceAckStore } from "../src/enforce";
import { context, FakeHistoryFileSystem } from "./support/history-fakes";

function record(turnId: string) {
  return {
    turnId,
    ruleIds: ["SECRETS-001"],
    timestamp: "2026-01-01T00:00:00.000Z",
  } as const;
}

function build(
  fileSystem: FakeHistoryFileSystem,
  limits: { maxBytes?: number; maxRecords?: number } = {},
): LocalEnforceAckStore {
  return createLocalEnforceAckStore({ context: context({ xdg: "/data" }), fileSystem, ...limits });
}

describe("local enforce acknowledgement ledger", () => {
  test("round-trips appended records", async () => {
    const store = build(new FakeHistoryFileSystem());

    await expect(store.append(record("t1"))).resolves.toBe("WRITTEN");
    await expect(store.append(record("t2"))).resolves.toBe("WRITTEN");

    await expect(store.read()).resolves.toEqual({
      status: "READ",
      records: [record("t1"), record("t2")],
      skippedLineCount: 0,
    });
  });

  test("reads a missing file as empty", async () => {
    await expect(build(new FakeHistoryFileSystem()).read()).resolves.toEqual({
      status: "READ",
      records: [],
      skippedLineCount: 0,
    });
  });

  test("skips and counts malformed lines", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const path = resolveEnforceAcksFilePath(context({ xdg: "/data" }));

    fileSystem.files.set(
      path,
      [
        "{not json",
        JSON.stringify({ turnId: "t1", ruleIds: [], timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({ turnId: "t2", ruleIds: ["A"], timestamp: "not a date" }),
        JSON.stringify({
          turnId: "t3",
          ruleIds: ["A"],
          timestamp: "2026-01-01T00:00:00.000Z",
          x: 1,
        }),
        JSON.stringify({ turnId: "", ruleIds: ["A"], timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify(record("t4")),
      ].join("\n"),
    );

    await expect(build(fileSystem).read()).resolves.toEqual({
      status: "READ",
      records: [record("t4")],
      skippedLineCount: 5,
    });
  });

  test("bounds the file to the newest records once it passes the byte limit", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const store = build(fileSystem, { maxBytes: 1, maxRecords: 2 });

    await store.append(record("t1"));
    await store.append(record("t2"));
    await store.append(record("t3"));

    await expect(store.read()).resolves.toEqual({
      status: "READ",
      records: [record("t2"), record("t3")],
      skippedLineCount: 0,
    });
  });

  test("refuses a record its own reader would skip, writing nothing", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const store = build(fileSystem);
    const tooManyRules = Array.from({ length: MAX_ACK_RULE_IDS + 1 }, (_, i) => `RULE-${i}`);

    await expect(store.append({ ...record("t1"), ruleIds: tooManyRules })).resolves.toBe("FAILED");
    await expect(
      store.append({ ...record("t1"), turnId: "x".repeat(MAX_ACK_FIELD_LENGTH + 1) }),
    ).resolves.toBe("FAILED");
    await expect(store.append({ ...record("t1"), ruleIds: [] })).resolves.toBe("FAILED");
    await expect(store.append({ ...record("t1"), timestamp: "not a date" })).resolves.toBe(
      "FAILED",
    );

    await expect(store.read()).resolves.toEqual({
      status: "READ",
      records: [],
      skippedLineCount: 0,
    });
    expect(fileSystem.files.get(resolveEnforceAcksFilePath(context({ xdg: "/data" })))).toBe(
      undefined,
    );
  });

  test("accepts the exact bounds it reads: 32 rule IDs and a 128-character turn", async () => {
    const store = build(new FakeHistoryFileSystem());
    const turnId = "t".repeat(MAX_ACK_FIELD_LENGTH);
    const ruleIds = Array.from({ length: MAX_ACK_RULE_IDS }, (_, i) => `RULE-${i}`);
    const full = { turnId, ruleIds, timestamp: "2026-01-01T00:00:00.000Z" };

    await expect(store.append(full)).resolves.toBe("WRITTEN");
    await expect(store.read()).resolves.toEqual({
      status: "READ",
      records: [full],
      skippedLineCount: 0,
    });
  });

  test("isAcknowledged keys on the unit code alone", () => {
    const records = [record("t1"), { ...record("t2"), ruleIds: ["OTHER-001"] }];

    expect(isAcknowledged(records, "t1")).toBe(true);
    expect(isAcknowledged(records, "t2")).toBe(true);
    expect(isAcknowledged(records, "t3")).toBe(false);
    expect(isAcknowledged([], "t1")).toBe(false);
  });

  test("isAckRecord matches the parser's bounds", () => {
    expect(isAckRecord(record("t1"))).toBe(true);
    expect(isAckRecord({ ...record("t1"), ruleIds: ["R".repeat(MAX_ACK_FIELD_LENGTH + 1)] })).toBe(
      false,
    );
    expect(
      isAckRecord({
        ...record("t1"),
        ruleIds: Array.from({ length: MAX_ACK_RULE_IDS + 1 }, (_, i) => `R-${i}`),
      }),
    ).toBe(false);
    expect(isAckRecord({ ...record("t1"), timestamp: "" })).toBe(false);
  });
});
