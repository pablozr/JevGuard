import { describe, expect, test } from "vitest";
import { createLocalEnforceAckStore, resolveEnforceAcksFilePath } from "../src/enforce";
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
});
