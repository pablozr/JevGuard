import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveFeedbackFilePath, resolveFeedbackSelectionFilePath } from "../src/feedback";
import type { LocalFeedbackStore } from "../src/index";
import { createLocalFeedbackStore, createNodeReviewHistoryFileSystem } from "../src/index";
import { context, FakeHistoryFileSystem } from "./support/history-fakes";

function record(turnId: string, decision: "RIGHT" | "WRONG" = "WRONG") {
  return { turnId, ruleId: "no-eval", decision, timestamp: "2026-01-01T00:00:00.000Z" } as const;
}

function build(
  fileSystem: FakeHistoryFileSystem,
  limits: { maxBytes?: number; maxRecords?: number } = {},
): LocalFeedbackStore {
  return createLocalFeedbackStore({ context: context({ xdg: "/data" }), fileSystem, ...limits });
}

describe("local feedback store records", () => {
  test("round-trips appended records", async () => {
    const store = build(new FakeHistoryFileSystem());

    await expect(store.append(record("t1"))).resolves.toBe("WRITTEN");
    await expect(store.append(record("t2", "RIGHT"))).resolves.toBe("WRITTEN");

    await expect(store.read()).resolves.toEqual({
      status: "READ",
      records: [record("t1"), record("t2", "RIGHT")],
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
    const path = resolveFeedbackFilePath(context({ xdg: "/data" }));
    const valid = JSON.stringify(record("t1"));

    fileSystem.files.set(
      path,
      [
        "{not json",
        JSON.stringify({ ...record("t2"), decision: "MAYBE" }),
        JSON.stringify({ ...record("t3"), extra: "x" }),
        JSON.stringify({ ...record("t4"), ruleId: "" }),
        JSON.stringify({ ...record("t5"), timestamp: "not a date" }),
        valid,
      ].join("\n"),
    );

    await expect(build(fileSystem).read()).resolves.toEqual({
      status: "READ",
      records: [record("t1")],
      skippedLineCount: 5,
    });
  });

  test("reports a read error without throwing", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.failRead = true;

    await expect(build(fileSystem).read()).resolves.toEqual({ status: "FAILED" });
  });

  test("reports an append error without throwing", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.failAppend = true;

    await expect(build(fileSystem).append(record("t1"))).resolves.toBe("FAILED");
  });

  test("writes only the four allowlisted fields", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const polluted = { ...record("t1"), task: "secret task" };

    await build(fileSystem).append(polluted);

    const line = fileSystem.files.get(resolveFeedbackFilePath(context({ xdg: "/data" }))) ?? "";

    expect(Object.keys(JSON.parse(line)).sort()).toEqual([
      "decision",
      "ruleId",
      "timestamp",
      "turnId",
    ]);
    expect(line).not.toContain("secret task");
  });

  test("rotates to the newest records past the byte limit", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const store = build(fileSystem, { maxBytes: 10, maxRecords: 2 });

    await store.append(record("t1"));
    await store.append(record("t2"));
    await store.append(record("t3"));

    const result = await store.read();

    expect(fileSystem.atomicWrites.length).toBeGreaterThan(0);
    expect(result.status === "READ" && result.records.map((entry) => entry.turnId)).toEqual([
      "t2",
      "t3",
    ]);
  });
});

describe("feedback paths", () => {
  test("honors an absolute XDG_DATA_HOME", () => {
    const path = resolveFeedbackFilePath(context({ xdg: "/data" }));

    expect(path.replaceAll("\\", "/")).toBe("/data/jevguard/feedback.jsonl");
  });

  test("falls back to ~/.local/share for a relative XDG_DATA_HOME", () => {
    const path = resolveFeedbackSelectionFilePath(context({ xdg: "relative", homedir: "/home/u" }));

    expect(path.replaceAll("\\", "/")).toBe(
      "/home/u/.local/share/jevguard/feedback-selection.json",
    );
  });
});

describe("feedback selection", () => {
  const selection = {
    version: 1,
    listedAt: "2026-01-01T00:00:00.000Z",
    items: [{ turnId: "t1", ruleId: "no-eval" }],
  } as const;

  test("round-trips", async () => {
    const store = build(new FakeHistoryFileSystem());

    await expect(store.writeSelection(selection)).resolves.toBe("WRITTEN");
    await expect(store.readSelection()).resolves.toEqual({ status: "READ", selection });
  });

  test("reads an absent selection as null", async () => {
    await expect(build(new FakeHistoryFileSystem()).readSelection()).resolves.toEqual({
      status: "READ",
      selection: null,
    });
  });

  test("reads a malformed selection as null", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.files.set(resolveFeedbackSelectionFilePath(context({ xdg: "/data" })), "{oops");

    await expect(build(fileSystem).readSelection()).resolves.toEqual({
      status: "READ",
      selection: null,
    });
  });

  test("reports a read error", async () => {
    const fileSystem = new FakeHistoryFileSystem();

    fileSystem.failRead = true;

    await expect(build(fileSystem).readSelection()).resolves.toEqual({ status: "FAILED" });
  });
});

describe.skipIf(process.platform === "win32")("feedback files on a real filesystem", () => {
  test("creates the feedback files as owner-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "jevguard-feedback-"));
    const store = createLocalFeedbackStore({
      context: context({ xdg: root }),
      fileSystem: createNodeReviewHistoryFileSystem(),
    });

    try {
      await store.append(record("t1"));
      await store.writeSelection({
        version: 1,
        listedAt: "2026-01-01T00:00:00.000Z",
        items: [{ turnId: "t1", ruleId: "no-eval" }],
      });

      expect(statSync(join(root, "jevguard")).mode & 0o777).toBe(0o700);
      expect(statSync(join(root, "jevguard", "feedback.jsonl")).mode & 0o777).toBe(0o600);
      expect(statSync(join(root, "jevguard", "feedback-selection.json")).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
