import type { Turn } from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  createTurnTracker,
  executionTask,
  InMemoryTurnDeduplicator,
  locateExecution,
  MAX_OPEN_SNAPSHOTS,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_TOTAL_BYTES,
  normalizeFileDiff,
  writtenPaths,
} from "../src/index";
import type {
  FileContent,
  OpenCodeMessage,
  OpenCodeSessionFacade,
  TurnAttribution,
  TurnTracker,
  WorkingFileDiff,
} from "../src/index";

class FakeSessionFacade implements OpenCodeSessionFacade {
  messages = new Map<string, readonly OpenCodeMessage[]>();
  diffs: readonly WorkingFileDiff[] = [];
  files = new Map<string, FileContent>();
  parents = new Map<string, string>();
  listError: Error | null = null;
  diffError: Error | null = null;
  diffReads = 0;

  listMessages(sessionID: string): Promise<readonly OpenCodeMessage[]> {
    if (this.listError !== null) {
      return Promise.reject(this.listError);
    }

    return Promise.resolve(this.messages.get(sessionID) ?? []);
  }

  snapshotWorking(): Promise<readonly WorkingFileDiff[]> {
    this.diffReads += 1;

    if (this.diffError !== null) {
      return Promise.reject(this.diffError);
    }

    return Promise.resolve(this.diffs);
  }

  readFiles(paths: readonly string[]): Promise<ReadonlyMap<string, FileContent>> {
    return Promise.resolve(
      new Map(paths.map((path) => [path, this.files.get(path) ?? { kind: "MISSING" }])),
    );
  }

  parentSessionID(sessionID: string): Promise<string | null> {
    return Promise.resolve(this.parents.get(sessionID) ?? null);
  }
}

function user(id: string, text: string): OpenCodeMessage {
  return { id, type: "user", text, completed: false };
}

function synthetic(id: string, text: string): OpenCodeMessage {
  return { id, type: "synthetic", text, completed: false };
}

function assistant(id: string, completed = true): OpenCodeMessage {
  return { id, type: "assistant", completed };
}

function idle(id: string): OpenCodeMessage {
  return { id, type: "idle", completed: false };
}

function text(value: string): FileContent {
  return { kind: "TEXT", text: value };
}

function attributedTurn(result: TurnAttribution): Turn {
  if (result.status !== "ATTRIBUTED") {
    throw new Error(`expected ATTRIBUTED, received ${JSON.stringify(result)}`);
  }

  return result.turn;
}

function setup(): { facade: FakeSessionFacade; tracker: TurnTracker } {
  const facade = new FakeSessionFacade();
  const tracker = createTurnTracker({ facade, deduplicator: new InMemoryTurnDeduplicator() });

  return { facade, tracker };
}

async function begin(tracker: TurnTracker, sessionID: string): Promise<void> {
  await tracker.start(sessionID, tracker.noteStarted(sessionID));
}

describe("normalizeFileDiff", () => {
  test("uses a provided patch verbatim", () => {
    const result = normalizeFileDiff({ file: "src/auth.ts", patch: "diff --git a/src/auth.ts" });

    expect(result).toEqual({
      status: "PATCH",
      file: { path: "src/auth.ts", patch: "diff --git a/src/auth.ts" },
    });
  });

  test("rebuilds a unified patch from before/after with real paths", () => {
    const result = normalizeFileDiff({
      file: "src/auth.ts",
      before: "old\nline",
      after: "new\nline",
    });

    expect(result.status).toBe("PATCH");

    if (result.status !== "PATCH") {
      return;
    }

    expect(result.file.path).toBe("src/auth.ts");
    expect(result.file.patch).toContain("--- a/src/auth.ts");
    expect(result.file.patch).toContain("+++ b/src/auth.ts");
    expect(result.file.patch).toContain("@@ -1,2 +1,2 @@");
    expect(result.file.patch).toContain("-old");
    expect(result.file.patch).toContain("+new");
  });

  test("marks added and deleted files with /dev/null", () => {
    const added = normalizeFileDiff({ file: "src/new.ts", before: "", after: "hello" });
    const deleted = normalizeFileDiff({ file: "src/gone.ts", before: "hello", after: "" });

    expect(added.status).toBe("PATCH");
    expect(deleted.status).toBe("PATCH");

    if (added.status === "PATCH") {
      expect(added.file.patch).toContain("--- /dev/null");
      expect(added.file.patch).toContain("+++ b/src/new.ts");
      expect(added.file.patch).toContain("@@ -0,0 +1,1 @@");
    }

    if (deleted.status === "PATCH") {
      expect(deleted.file.patch).toContain("--- a/src/gone.ts");
      expect(deleted.file.patch).toContain("+++ /dev/null");
      expect(deleted.file.patch).toContain("@@ -1,1 +0,0 @@");
    }
  });

  test("reports empty content and incomplete diffs explicitly", () => {
    expect(normalizeFileDiff({ file: "src/same.ts", before: "same", after: "same" })).toEqual({
      status: "EMPTY",
    });
    expect(normalizeFileDiff({ file: "src/x.ts" })).toEqual({ status: "INCOMPLETE" });
    expect(normalizeFileDiff({ file: "src/x.ts", patch: "" })).toEqual({ status: "INCOMPLETE" });
    expect(normalizeFileDiff({ patch: "diff" })).toEqual({ status: "INCOMPLETE" });
  });
});

describe("locateExecution and executionTask", () => {
  test("takes the messages after the last idle marker, ignoring trailing idle markers", () => {
    const located = locateExecution([
      user("u0", "old task"),
      assistant("a0"),
      idle("i0"),
      user("u1", "first"),
      assistant("a1"),
      synthetic("s1", "queued"),
      assistant("a2"),
      assistant("a3", false),
      idle("i1"),
    ]);

    expect(located?.assistant.id).toBe("a2");
    expect(located?.inputs.map((message) => message.id)).toEqual(["u1", "s1"]);
  });

  test("returns null when the execution has no completed assistant", () => {
    expect(locateExecution([user("u1", "task"), assistant("a1", false)])).toBeNull();
    expect(locateExecution([])).toBeNull();
  });

  test("joins user and synthetic inputs with a blank line and drops empty texts", () => {
    expect(
      executionTask([user("u1", "first"), synthetic("s1", "  "), synthetic("s2", "second")]),
    ).toBe("first\n\nsecond");
    expect(executionTask([user("u1", "   ")])).toBeNull();
  });
});

describe("writtenPaths", () => {
  const root = process.platform === "win32" ? "C:\\repo" : "/repo";

  test("reads path and filePath from write tools relative to the root", () => {
    expect(writtenPaths("write", { filePath: "src/a.ts" }, root)).toEqual(["src/a.ts"]);
    expect(writtenPaths("edit", { path: `${root}/src/b.ts` }, root)).toEqual(["src/b.ts"]);
  });

  test("reads the file headers of a patch, including moves", () => {
    const patchText = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "*** Update File: src/old.ts",
      "*** Move to: src/moved.ts",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");

    expect(writtenPaths("apply_patch", { patchText }, root)).toEqual([
      "src/new.ts",
      "src/old.ts",
      "src/moved.ts",
      "src/gone.ts",
    ]);
  });

  test("keeps a path outside the root absolute and ignores non-write tools", () => {
    const outside = writtenPaths("write", { filePath: "../elsewhere.ts" }, root);

    expect(outside).toHaveLength(1);
    expect(outside[0]?.startsWith("src/")).toBe(false);
    expect(writtenPaths("read", { filePath: "src/a.ts" }, root)).toEqual([]);
    expect(writtenPaths("bash", "echo", root)).toEqual([]);
  });
});

describe("turn tracker", () => {
  test("attributes a clean-at-start file with the host patch and the joined task", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.diffs = [{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" }];
    facade.messages.set("ses_1", [
      user("u1", "do it"),
      synthetic("s1", "and this"),
      assistant("a1"),
    ]);

    const turn = attributedTurn(await tracker.finish("ses_1"));

    expect(turn).toEqual({
      id: "a1",
      task: "do it\n\nand this",
      files: [{ path: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b\n" }],
    });
  });

  test("excludes prior dirt and rebuilds a dirty-at-start file from its start content", async () => {
    const { facade, tracker } = setup();

    facade.diffs = [
      { file: "src/dirty.ts", patch: "P-dirty" },
      { file: "src/untouched.ts", patch: "P-untouched" },
    ];
    facade.files.set("src/dirty.ts", text("start\n"));
    facade.files.set("src/untouched.ts", text("same\n"));
    await begin(tracker, "ses_1");

    facade.diffs = [
      { file: "src/dirty.ts", patch: "P-dirty-2" },
      { file: "src/untouched.ts", patch: "P-untouched" },
    ];
    facade.files.set("src/dirty.ts", text("end\n"));
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    const turn = attributedTurn(await tracker.finish("ses_1"));

    expect(turn.files.map((file) => file.path)).toEqual(["src/dirty.ts"]);
    expect(turn.files[0]?.patch).toContain("-start");
    expect(turn.files[0]?.patch).toContain("+end");
  });

  test("attributes an untracked file created by the turn", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.diffs = [{ file: "src/new.ts", patch: "--- /dev/null\n+++ b/src/new.ts\n+x\n" }];
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);
    tracker.recordWrite("ses_1", "src/new.ts");

    expect(attributedTurn(await tracker.finish("ses_1")).files).toHaveLength(1);
  });

  test("reports INCOMPLETE_FILE_DIFF for a truncated patch", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.diffs = [{ file: "src/a.ts", patch: "@@", more: true }];
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    expect(await tracker.finish("ses_1")).toEqual({
      status: "UNAVAILABLE",
      reason: "INCOMPLETE_FILE_DIFF",
    });
  });

  test("reports INCOMPLETE_FILE_DIFF when a dirty start file exceeds the cap", async () => {
    const { facade, tracker } = setup();

    facade.diffs = [{ file: "src/big.ts", patch: "P" }];
    facade.files.set("src/big.ts", { kind: "OVERSIZED" });
    await begin(tracker, "ses_1");
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    expect(await tracker.finish("ses_1")).toEqual({
      status: "UNAVAILABLE",
      reason: "INCOMPLETE_FILE_DIFF",
    });
  });

  test("reports INCOMPLETE_FILE_DIFF when the attributed patch exceeds the caps", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.diffs = [{ file: "src/a.ts", patch: "x".repeat(MAX_SNAPSHOT_FILE_BYTES + 1) }];
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    expect(await tracker.finish("ses_1")).toMatchObject({ reason: "INCOMPLETE_FILE_DIFF" });
    expect(MAX_SNAPSHOT_TOTAL_BYTES).toBe(2 * 1024 * 1024);
  });

  test("reports INCOMPLETE_FILE_DIFF when a tool wrote a path the diff never shows", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.diffs = [{ file: "src/a.ts", patch: "@@ a" }];
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);
    tracker.recordWrite("ses_1", "dist/ignored.js");

    expect(await tracker.finish("ses_1")).toEqual({
      status: "UNAVAILABLE",
      reason: "INCOMPLETE_FILE_DIFF",
    });
  });

  test("reports MISSING_TURN_START when the plugin never saw the start", async () => {
    const { facade, tracker } = setup();

    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    expect(await tracker.finish("ses_1")).toEqual({
      status: "UNAVAILABLE",
      reason: "MISSING_TURN_START",
    });
  });

  test("stays silent for a start-less finish that is a duplicate or has no completed assistant", async () => {
    const { facade, tracker } = setup();

    expect(await tracker.finish("ses_1")).toEqual({ status: "NONE" });

    await begin(tracker, "ses_1");
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);
    expect((await tracker.finish("ses_1")).status).toBe("ATTRIBUTED");
    expect(await tracker.finish("ses_1")).toEqual({ status: "ALREADY_PROCESSED" });
  });

  test("reports BOUNDARY_RACE when a new start arrives before the previous one is consumed", async () => {
    const { facade, tracker } = setup();

    const first = tracker.noteStarted("ses_1");
    tracker.noteStarted("ses_1");
    await tracker.start("ses_1", first);
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    expect(await tracker.finish("ses_1")).toEqual({
      status: "UNAVAILABLE",
      reason: "BOUNDARY_RACE",
    });
  });

  test("reports CONCURRENT_SESSIONS for overlapping top-level executions", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    await begin(tracker, "ses_2");
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);
    facade.messages.set("ses_2", [user("u2", "task"), assistant("a2")]);

    expect(await tracker.finish("ses_1")).toMatchObject({ reason: "CONCURRENT_SESSIONS" });
    expect(await tracker.finish("ses_2")).toMatchObject({ reason: "CONCURRENT_SESSIONS" });
  });

  test("folds a nested subagent session into its parent execution", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.parents.set("ses_sub", "ses_1");
    await begin(tracker, "ses_sub");
    tracker.recordWrite("ses_sub", "src/a.ts");
    facade.diffs = [{ file: "src/a.ts", patch: "@@ a" }];

    expect(await tracker.finish("ses_sub")).toEqual({ status: "NONE" });

    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    expect(attributedTurn(await tracker.finish("ses_1")).files).toHaveLength(1);
  });

  test("discard drops the execution and reports whether it was nested", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.parents.set("ses_sub", "ses_1");
    await begin(tracker, "ses_sub");

    expect(tracker.discard("ses_sub")).toEqual({ nested: true });
    expect(tracker.discard("ses_1")).toEqual({ nested: false });
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);
    expect(await tracker.finish("ses_1")).toMatchObject({ reason: "MISSING_TURN_START" });
  });

  test("returns NONE without a completed assistant and reports message and task failures", async () => {
    const { facade, tracker } = setup();

    await begin(tracker, "ses_1");
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1", false)]);
    expect(await tracker.finish("ses_1")).toEqual({ status: "NONE" });

    await begin(tracker, "ses_1");
    facade.messages.set("ses_1", [assistant("a1")]);
    expect(await tracker.finish("ses_1")).toMatchObject({ reason: "MISSING_TASK_MESSAGE" });

    await begin(tracker, "ses_1");
    facade.messages.set("ses_1", [user("u1", "  "), assistant("a2")]);
    expect(await tracker.finish("ses_1")).toMatchObject({ reason: "EMPTY_TASK" });

    await begin(tracker, "ses_1");
    facade.listError = new Error("down");
    expect(await tracker.finish("ses_1")).toMatchObject({ reason: "MESSAGE_READ_FAILURE" });
  });

  test("reports DIFF_READ_FAILURE when the start snapshot or end diff fails", async () => {
    const { facade, tracker } = setup();

    facade.diffError = new Error("git failed");
    await begin(tracker, "ses_1");
    facade.diffError = null;
    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);

    expect(await tracker.finish("ses_1")).toMatchObject({ reason: "DIFF_READ_FAILURE" });
  });

  test("reviews one assistant message only once", async () => {
    const { facade, tracker } = setup();

    facade.messages.set("ses_1", [user("u1", "task"), assistant("a1")]);
    await begin(tracker, "ses_1");
    attributedTurn(await tracker.finish("ses_1"));
    await begin(tracker, "ses_1");

    expect(await tracker.finish("ses_1")).toEqual({ status: "ALREADY_PROCESSED" });
  });

  test("evicts the oldest open snapshot beyond the limit", async () => {
    const { facade, tracker } = setup();

    for (let index = 0; index <= MAX_OPEN_SNAPSHOTS; index += 1) {
      await begin(tracker, `ses_${index}`);
    }

    facade.messages.set("ses_0", [user("u1", "task"), assistant("a1")]);

    expect(await tracker.finish("ses_0")).toMatchObject({ reason: "MISSING_TURN_START" });
  });
});
