import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
  DeliveryStatus,
  LocalReviewHistory,
  ReviewLogEntry,
  StructuredLogSink,
} from "../src/index";
import {
  createLocalReviewHistory,
  createMirroredReviewLogSink,
  createNodeReviewHistoryFileSystem,
  resolveHistoryFilePath,
} from "../src/index";
import { context, FakeHistoryFileSystem } from "./support/history-fakes";

function historyWith(
  fileSystem: FakeHistoryFileSystem,
  options: {
    readonly contextOverrides?: { readonly xdg?: string | undefined; readonly homedir?: string };
    readonly maxBytes?: number;
    readonly maxRecords?: number;
    readonly now?: () => Date;
  } = {},
): LocalReviewHistory {
  return createLocalReviewHistory({
    context: context(options.contextOverrides),
    fileSystem,
    now: options.now ?? (() => new Date("2026-01-01T00:00:00.000Z")),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxRecords === undefined ? {} : { maxRecords: options.maxRecords }),
  });
}

function entry(turnId = "turn-1"): ReviewLogEntry {
  return {
    turnId,
    summary: {
      highestVerdict: "PASS",
      hasUnavailable: false,
      counts: { pass: 1, warn: 0, fail: 0, skipped: 0, unavailable: 0 },
    },
    results: [
      {
        kind: "RULE",
        ruleId: "R-1",
        severity: "error",
        scopedPaths: ["src/a.ts"],
        outcome: "PASS",
        violationProbability: 0.1,
      },
    ],
  };
}

describe("local review history path", () => {
  test("uses the homedir data convention when XDG_DATA_HOME is absent", () => {
    expect(resolveHistoryFilePath(context())).toBe(
      join("C:/home", ".local", "share", "jevguard", "reviews.jsonl"),
    );
  });

  test("uses an absolute XDG_DATA_HOME", () => {
    expect(resolveHistoryFilePath(context({ xdg: "D:/data" }))).toBe(
      join("D:/data", "jevguard", "reviews.jsonl"),
    );
  });

  test("ignores a relative or empty XDG_DATA_HOME", () => {
    expect(resolveHistoryFilePath(context({ xdg: "relative/data" }))).toBe(
      join("C:/home", ".local", "share", "jevguard", "reviews.jsonl"),
    );
    expect(resolveHistoryFilePath(context({ xdg: "" }))).toBe(
      join("C:/home", ".local", "share", "jevguard", "reviews.jsonl"),
    );
  });
});

describe("local review history append and read", () => {
  test("round-trips one entry with a timestamp", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const history = historyWith(fileSystem);

    await history.append(entry("turn-7"));

    const result = await history.read();

    expect(result.skippedLineCount).toBe(0);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      turnId: "turn-7",
      timestamp: "2026-01-01T00:00:00.000Z",
      results: [{ kind: "RULE", ruleId: "R-1", outcome: "PASS" }],
    });
    expect(fileSystem.ensuredDirectories).toEqual([resolveHistoryFilePath(context())]);
  });

  test("skips a malformed line and counts it without crashing", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const history = historyWith(fileSystem);

    await history.append(entry("turn-1"));

    const path = resolveHistoryFilePath(context());
    fileSystem.files.set(
      path,
      `${fileSystem.files.get(path) ?? ""}not json\n${JSON.stringify({ turnId: 1 })}\n`,
    );

    const result = await history.read();

    expect(result.records).toHaveLength(1);
    expect(result.skippedLineCount).toBe(2);
  });

  test("skips valid JSON whose record shape is malformed", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const history = historyWith(fileSystem);
    const path = resolveHistoryFilePath(context());
    const badResult = {
      turnId: "turn-x",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: {},
      results: [{ kind: "RULE", outcome: "FAIL" }],
    };
    const badEvidence = {
      turnId: "turn-y",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: {},
      results: [
        {
          kind: "RULE",
          ruleId: "R-1",
          outcome: "PASS",
          violationProbability: 0.1,
          evidence: { mode: "SLICED" },
        },
      ],
    };

    fileSystem.files.set(path, `${JSON.stringify(badResult)}\n${JSON.stringify(badEvidence)}\n`);

    const result = await history.read();

    expect(result.records).toHaveLength(0);
    expect(result.skippedLineCount).toBe(2);
  });

  test("reads a missing file as empty", async () => {
    const history = historyWith(new FakeHistoryFileSystem());

    await expect(history.read()).resolves.toEqual({ records: [], skippedLineCount: 0 });
  });

  test("contains a write failure without rejecting", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    fileSystem.failAppend = true;
    const history = historyWith(fileSystem);

    await expect(history.append(entry())).resolves.toBeUndefined();
    await expect(history.read()).resolves.toEqual({ records: [], skippedLineCount: 0 });
  });

  test("rewrites over the size threshold keeping the newest records atomically", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const history = historyWith(fileSystem, { maxBytes: 1, maxRecords: 2 });

    await history.append(entry("turn-1"));
    await history.append(entry("turn-2"));
    await history.append(entry("turn-3"));

    const result = await history.read();

    expect(result.records.map((record) => record.turnId)).toEqual(["turn-2", "turn-3"]);
    expect(fileSystem.atomicWrites.length).toBeGreaterThan(0);

    const path = resolveHistoryFilePath(context());
    const contents = fileSystem.files.get(path) ?? "";
    const lines = contents.split("\n").filter((line) => line.trim() !== "");

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});

describe("local review history strict read", () => {
  test("reads a missing file as an empty READ", async () => {
    const history = historyWith(new FakeHistoryFileSystem());

    await expect(history.readStrict()).resolves.toEqual({
      status: "READ",
      records: [],
      skippedLineCount: 0,
    });
  });

  test("reports an I/O error as FAILED while the tolerant read stays empty", async () => {
    const fileSystem = new FakeHistoryFileSystem();
    const history = historyWith(fileSystem);

    await history.append(entry("turn-1"));
    fileSystem.failRead = true;

    await expect(history.readStrict()).resolves.toEqual({ status: "FAILED" });
    await expect(history.read()).resolves.toEqual({ records: [], skippedLineCount: 0 });
  });

  test("returns the records of a valid file", async () => {
    const history = historyWith(new FakeHistoryFileSystem());

    await history.append(entry("turn-1"));
    await history.append(entry("turn-2"));

    const result = await history.readStrict();

    expect(result.status).toBe("READ");
    expect(result.status === "READ" ? result.records.map((item) => item.turnId) : []).toEqual([
      "turn-1",
      "turn-2",
    ]);
  });
});

describe("mirrored review log sink", () => {
  class FakeHostSink implements StructuredLogSink {
    readonly entries: ReviewLogEntry[] = [];
    status: DeliveryStatus = "DELIVERED";
    fail = false;

    async write(entry: ReviewLogEntry): Promise<DeliveryStatus> {
      this.entries.push(entry);

      if (this.fail) {
        throw new Error("host down");
      }

      return this.status;
    }
  }

  test("delivers the entry to both the host sink and the history", async () => {
    const host = new FakeHostSink();
    const fileSystem = new FakeHistoryFileSystem();
    const history = historyWith(fileSystem);
    const sink = createMirroredReviewLogSink(host, history);

    const status = await sink.write(entry("turn-9"));

    expect(status).toBe("DELIVERED");
    expect(host.entries).toHaveLength(1);
    expect((await history.read()).records).toHaveLength(1);
  });

  test("a host failure does not prevent the history append", async () => {
    const host = new FakeHostSink();
    host.fail = true;
    const fileSystem = new FakeHistoryFileSystem();
    const history = historyWith(fileSystem);
    const sink = createMirroredReviewLogSink(host, history);

    await expect(sink.write(entry())).resolves.toBe("FAILED");
    expect((await history.read()).records).toHaveLength(1);
  });

  test("a history failure does not prevent the host write", async () => {
    const host = new FakeHostSink();
    const failingHistory = {
      append: async (): Promise<void> => {
        throw new Error("history down");
      },
    };
    const sink = createMirroredReviewLogSink(host, failingHistory);

    await expect(sink.write(entry())).resolves.toBe("DELIVERED");
    expect(host.entries).toHaveLength(1);
  });
});

describe.skipIf(process.platform === "win32")("node review history file system", () => {
  test("creates the history directory and files as owner-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "jevguard-history-"));
    const fileSystem = createNodeReviewHistoryFileSystem();
    const appended = join(root, "jevguard", "reviews.jsonl");
    const rewritten = join(root, "jevguard", "rewritten.jsonl");

    try {
      await fileSystem.ensureParentDirectory(appended);
      await fileSystem.appendFile(appended, "{}\n");
      await fileSystem.writeFileAtomic(rewritten, "{}\n");

      expect(statSync(join(root, "jevguard")).mode & 0o777).toBe(0o700);
      expect(statSync(appended).mode & 0o777).toBe(0o600);
      expect(statSync(rewritten).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
