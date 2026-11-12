import {
  DEFAULT_EVIDENCE_POLICY,
  type ParsedRule,
  parseUnifiedDiff,
  planRuleEvidence,
  type Turn,
} from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  createTurnTracker,
  executionDelivery,
  executionTask,
  InMemoryTurnDeduplicator,
  locateExecution,
  MAX_OPEN_SNAPSHOTS,
  MAX_SNAPSHOT_FILE_BYTES,
  MAX_SNAPSHOT_TOTAL_BYTES,
  attributeSnapshotDiff,
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
    expect(result.file.patch).toBe(
      "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n line\n\\ No newline at end of file\n",
    );
    expect(result.file.patch).not.toContain("=====");
  });

  test("marks added and deleted files with /dev/null", () => {
    const added = normalizeFileDiff({ file: "src/new.ts", before: "", after: "hello" });
    const deleted = normalizeFileDiff({ file: "src/gone.ts", before: "hello", after: "" });

    expect(added.status).toBe("PATCH");
    expect(deleted.status).toBe("PATCH");

    if (added.status === "PATCH") {
      expect(added.file.patch).toBe(
        "--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+hello\n\\ No newline at end of file\n",
      );
    }

    if (deleted.status === "PATCH") {
      expect(deleted.file.patch).toBe(
        "--- a/src/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-hello\n\\ No newline at end of file\n",
      );
    }
  });

  test("emits one minimal hunk with 3 context lines for a single changed line", () => {
    const rows = Array.from({ length: 100 }, (_, index) => `line ${index}`);
    const before = `${rows.join("\n")}\n`;
    const after = `${rows.map((row, index) => (index === 50 ? "line fifty" : row)).join("\n")}\n`;
    const result = normalizeFileDiff({ file: "src/big.ts", before, after });

    expect(result.status).toBe("PATCH");

    if (result.status !== "PATCH") {
      return;
    }

    const patch = result.file.patch;
    const body = patch.split("\n").slice(3, -1);

    expect(patch.match(/^@@ /gm)).toHaveLength(1);
    expect(patch).toContain("@@ -48,7 +48,7 @@");
    expect(body).toHaveLength(8);
    expect(body.filter((row) => row.startsWith("-") || row.startsWith("+"))).toEqual([
      "-line 50",
      "+line fifty",
    ]);
    expect(patch).not.toContain("-line 0\n");
    expect(patch.length).toBeLessThan(300);
  });

  test("marks a missing final newline on the side that lacks it", () => {
    const result = normalizeFileDiff({ file: "x.ts", before: "a\nb", after: "a\nb\nc" });

    expect(result).toEqual({
      status: "PATCH",
      file: {
        path: "x.ts",
        patch:
          "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n",
      },
    });
  });

  test("a spent deadline is INCOMPLETE, never a partial patch", () => {
    const before = Array.from({ length: 20000 }, (_, index) => `l${index}`).join("\n");
    const after = Array.from({ length: 20000 }, (_, index) => `m${(index * 7) % 20000}`).join("\n");

    expect(normalizeFileDiff({ file: "src/a.ts", before: "a", after: "b" }, 0)).toEqual({
      status: "INCOMPLETE",
    });
    expect(normalizeFileDiff({ file: "src/a.ts", before, after }, 1)).toEqual({
      status: "INCOMPLETE",
    });
  });

  test("a rebuilt patch parses strictly and is sliced by hunk in the core planner", () => {
    const rows = (replacements: Readonly<Record<number, string>>) =>
      `${Array.from({ length: 120 }, (_, index) => replacements[index] ?? `line ${index}`).join("\n")}\n`;
    const result = normalizeFileDiff({
      file: "src/a.ts",
      before: rows({}),
      after: rows({ 5: "changed five", 110: "changed one-ten" }),
    });

    expect(result.status).toBe("PATCH");

    if (result.status !== "PATCH") {
      return;
    }

    const patch = result.file.patch;
    const rule: ParsedRule = {
      id: "R-1",
      severity: "error",
      scope: null,
      evidence: "code",
      description: "A rule.",
      violation: "A violation.",
      allowed: null,
    };
    const plan = planRuleEvidence(
      { id: "t1", task: "task", files: [{ path: "src/a.ts", patch }] },
      rule,
      {
        ...DEFAULT_EVIDENCE_POLICY,
        maxDiffLength: patch.length - 1,
      },
    );

    expect(parseUnifiedDiff(patch)).toEqual({
      status: "PARSED",
      files: [{ path: "src/a.ts", patch }],
    });
    expect(plan.status).toBe("PLANNED");

    if (plan.status !== "PLANNED") {
      return;
    }

    expect(plan.slices.map((slice) => slice.kind)).toEqual(["HUNK", "HUNK"]);
    expect(plan.slices.map((slice) => slice.hunkOrdinal)).toEqual([0, 1]);
    expect(
      plan.slices.every((slice) => slice.diff.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@ ")),
    ).toBe(true);
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
    expect(turn.files[0]?.patch).toBe(
      "--- a/src/dirty.ts\n+++ b/src/dirty.ts\n@@ -1,1 +1,1 @@\n-start\n+end\n",
    );
  });

  test("a spent patch budget makes a dirty-at-start attribution INCOMPLETE", async () => {
    const { facade, tracker } = setup();

    facade.diffs = [{ file: "src/dirty.ts", patch: "P-dirty" }];
    facade.files.set("src/dirty.ts", text("start\n"));
    await begin(tracker, "ses_1");

    const start = {
      diffs: new Map(facade.diffs.map((diff) => [diff.file, diff])),
      contents: new Map(facade.files),
      incomplete: false,
    };
    const endDiffs = [{ file: "src/dirty.ts", patch: "P-dirty-2" }];

    facade.files.set("src/dirty.ts", text("end\n"));

    expect(await attributeSnapshotDiff(start, endDiffs, facade, 0)).toBeNull();
    expect(await attributeSnapshotDiff(start, endDiffs, facade)).toHaveLength(1);
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

describe("executionDelivery", () => {
  const marked = (id: string, value: unknown): OpenCodeMessage => ({
    id,
    type: "synthetic",
    completed: false,
    text: "frame",
    metadata: { jevguard: value },
  });
  const human: OpenCodeMessage = { id: "u1", type: "user", completed: false, text: "task" };

  test("reads the mark only from a synthetic message's metadata", () => {
    expect(executionDelivery([marked("s1", { v: 1, unitId: "msg_a" })])).toEqual({
      fromDelivery: true,
    });
    expect(executionDelivery([human])).toEqual({ fromDelivery: false });
    expect(
      executionDelivery([
        { ...human, metadata: { jevguard: { v: 1, unitId: "msg_a" } } } as OpenCodeMessage,
      ]),
    ).toEqual({ fromDelivery: false });
  });

  test("stays a delivery when a human input shares the execution", () => {
    expect(executionDelivery([human, marked("s1", { v: 1, unitId: "msg_a" })])).toEqual({
      fromDelivery: true,
    });
  });

  test("accepts the old chain mark and any malformed object", () => {
    for (const value of [
      { chainId: "msg_a", attempt: 1, maxAttempts: 2 },
      { chainId: "bad id", attempt: 9 },
      {},
    ]) {
      expect(executionDelivery([marked("s1", value)])).toEqual({ fromDelivery: true });
    }
  });

  test("ignores a mark that is not an object", () => {
    for (const value of ["msg_a", null, ["x"], undefined]) {
      expect(executionDelivery([marked("s1", value)])).toEqual({ fromDelivery: false });
    }
  });
});
