import type { Turn } from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  attributeTurn,
  extractTask,
  findCompletedAssistant,
  InMemoryTurnDeduplicator,
  normalizeFileDiff,
} from "../src/index";
import type {
  AttributeTurnDependencies,
  OpenCodeFileDiff,
  OpenCodeMessageInfo,
  OpenCodeMessageRecord,
  OpenCodePart,
  OpenCodeSessionFacade,
  TurnAttribution,
} from "../src/index";

interface DiffCall {
  readonly sessionID: string;
  readonly messageID: string;
}

class FakeSessionFacade implements OpenCodeSessionFacade {
  messages: readonly OpenCodeMessageRecord[] = [];
  diffs: readonly OpenCodeFileDiff[] = [];
  listError: Error | null = null;
  diffError: Error | null = null;
  readonly diffCalls: DiffCall[] = [];

  listMessages(): Promise<readonly OpenCodeMessageRecord[]> {
    if (this.listError !== null) {
      return Promise.reject(this.listError);
    }

    return Promise.resolve(this.messages);
  }

  fetchDiff(input: DiffCall): Promise<readonly OpenCodeFileDiff[]> {
    this.diffCalls.push(input);

    if (this.diffError !== null) {
      return Promise.reject(this.diffError);
    }

    return Promise.resolve(this.diffs);
  }
}

function user(id: string, parts: readonly OpenCodePart[]): OpenCodeMessageRecord {
  return { info: { id, role: "user", time: { created: 1 } }, parts };
}

function assistant(
  id: string,
  parentID: string,
  overrides: Partial<OpenCodeMessageInfo> = {},
): OpenCodeMessageRecord {
  return {
    info: {
      id,
      role: "assistant",
      parentID,
      time: { created: 1, completed: 2 },
      ...overrides,
    },
    parts: [],
  };
}

function text(value: string): OpenCodePart {
  return { type: "text", text: value };
}

function attributedTurn(result: TurnAttribution): Turn {
  if (result.status !== "ATTRIBUTED") {
    throw new Error(`expected ATTRIBUTED, received ${result.status}`);
  }

  return result.turn;
}

function dependencies(facade: OpenCodeSessionFacade): AttributeTurnDependencies {
  return { facade, deduplicator: new InMemoryTurnDeduplicator() };
}

describe("extractTask", () => {
  test("concatenates text parts in order and ignores non-text parts", () => {
    const parts: readonly OpenCodePart[] = [
      text("First line"),
      { type: "reasoning", text: "hidden reasoning" },
      { type: "tool" },
      text("Second line"),
    ];

    expect(extractTask(parts)).toBe("First line\nSecond line");
  });

  test("returns null when no text part carries content", () => {
    expect(extractTask([{ type: "tool" }])).toBeNull();
    expect(extractTask([text("   ")])).toBeNull();
    expect(extractTask([])).toBeNull();
  });
});

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

describe("findCompletedAssistant", () => {
  test("returns the most recent completed assistant message", () => {
    const records = [
      user("msg_u1", [text("first")]),
      assistant("msg_a1", "msg_u1"),
      user("msg_u2", [text("second")]),
      assistant("msg_a2", "msg_u2"),
    ];

    expect(findCompletedAssistant(records)?.id).toBe("msg_a2");
  });

  test("ignores incomplete, errored, summary, and parentless assistants", () => {
    const records = [
      assistant("msg_a1", "msg_u1", { time: { created: 1 } }),
      assistant("msg_a2", "msg_u2", { error: { name: "UnknownError" } }),
      assistant("msg_a3", "msg_u3", { summary: true }),
      assistant("msg_a4", ""),
    ];

    expect(findCompletedAssistant(records)).toBeNull();
  });
});

describe("attributeTurn", () => {
  test("maps the completed turn using the parent task and parent message diff", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [
      user("msg_u1", [text("Add rate limiting to login.")]),
      assistant("msg_a1", "msg_u1"),
    ];
    facade.diffs = [{ file: "src/auth/login.ts", patch: "diff --git a/src/auth/login.ts" }];

    const result = await attributeTurn("ses_1", dependencies(facade));

    expect(result).toEqual({
      status: "ATTRIBUTED",
      turn: {
        id: "msg_a1",
        task: "Add rate limiting to login.",
        files: [{ path: "src/auth/login.ts", patch: "diff --git a/src/auth/login.ts" }],
      },
    });
    expect(facade.diffCalls).toEqual([{ sessionID: "ses_1", messageID: "msg_u1" }]);
  });

  test("concatenates multiple text parts and ignores non-text parts", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [
      user("msg_u1", [text("First"), { type: "reasoning", text: "hidden" }, text("Second")]),
      assistant("msg_a1", "msg_u1"),
    ];
    facade.diffs = [{ file: "src/a.ts", patch: "patch" }];

    const turn = attributedTurn(await attributeTurn("ses_1", dependencies(facade)));

    expect(turn.task).toBe("First\nSecond");
  });

  test("returns NONE when no completed assistant exists and never reads a diff", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [
      user("msg_u1", [text("task")]),
      assistant("msg_a1", "msg_u1", { summary: true }),
    ];
    facade.diffs = [{ file: "src/a.ts", patch: "patch" }];

    const result = await attributeTurn("ses_1", dependencies(facade));

    expect(result).toEqual({ status: "NONE" });
    expect(facade.diffCalls).toHaveLength(0);
  });

  test("reports MISSING_PARENT_MESSAGE without reading a diff", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [assistant("msg_a1", "msg_missing")];

    const result = await attributeTurn("ses_1", dependencies(facade));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "MISSING_PARENT_MESSAGE" });
    expect(facade.diffCalls).toHaveLength(0);
  });

  test("reports EMPTY_TASK for a parent without usable text", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [user("msg_u1", [{ type: "tool" }]), assistant("msg_a1", "msg_u1")];

    const result = await attributeTurn("ses_1", dependencies(facade));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "EMPTY_TASK" });
    expect(facade.diffCalls).toHaveLength(0);
  });

  test("reports MESSAGE_READ_FAILURE when the message list cannot be read", async () => {
    const facade = new FakeSessionFacade();
    facade.listError = new Error("offline");

    const result = await attributeTurn("ses_1", dependencies(facade));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "MESSAGE_READ_FAILURE" });
  });

  test("reports INCOMPLETE_FILE_DIFF instead of using partial evidence", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [user("msg_u1", [text("task")]), assistant("msg_a1", "msg_u1")];
    facade.diffs = [
      { file: "src/a.ts", patch: "patch" },
      { file: "src/b.ts", patch: "" },
    ];

    const result = await attributeTurn("ses_1", dependencies(facade));

    expect(result).toEqual({ status: "UNAVAILABLE", reason: "INCOMPLETE_FILE_DIFF" });
  });

  test("attributed turn with an empty diff has no files", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [user("msg_u1", [text("task")]), assistant("msg_a1", "msg_u1")];
    facade.diffs = [];

    const turn = attributedTurn(await attributeTurn("ses_1", dependencies(facade)));

    expect(turn.files).toEqual([]);
  });

  test("retries after a diff read failure because failures are not marked", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [user("msg_u1", [text("task")]), assistant("msg_a1", "msg_u1")];
    facade.diffs = [{ file: "src/a.ts", patch: "patch" }];
    facade.diffError = new Error("transient");
    const deduplicator = new InMemoryTurnDeduplicator();

    const first = await attributeTurn("ses_1", { facade, deduplicator });
    facade.diffError = null;
    const second = await attributeTurn("ses_1", { facade, deduplicator });

    expect(first).toEqual({ status: "UNAVAILABLE", reason: "DIFF_READ_FAILURE" });
    expect(second.status).toBe("ATTRIBUTED");
    expect(facade.diffCalls).toHaveLength(2);
  });

  test("repeated idle events produce one attributed turn", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [user("msg_u1", [text("task")]), assistant("msg_a1", "msg_u1")];
    facade.diffs = [{ file: "src/a.ts", patch: "patch" }];
    const deduplicator = new InMemoryTurnDeduplicator();

    const first = await attributeTurn("ses_1", { facade, deduplicator });
    const second = await attributeTurn("ses_1", { facade, deduplicator });

    expect(first.status).toBe("ATTRIBUTED");
    expect(second).toEqual({ status: "ALREADY_PROCESSED" });
    expect(facade.diffCalls).toHaveLength(1);
  });

  test("a fresh deduplicator can attribute the same assistant message again", async () => {
    const facade = new FakeSessionFacade();
    facade.messages = [user("msg_u1", [text("task")]), assistant("msg_a1", "msg_u1")];
    facade.diffs = [{ file: "src/a.ts", patch: "patch" }];

    const first = await attributeTurn("ses_1", {
      facade,
      deduplicator: new InMemoryTurnDeduplicator(),
    });
    const second = await attributeTurn("ses_1", {
      facade,
      deduplicator: new InMemoryTurnDeduplicator(),
    });

    expect(first.status).toBe("ATTRIBUTED");
    expect(second.status).toBe("ATTRIBUTED");
  });
});
