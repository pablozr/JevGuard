import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type AttributionContext,
  createOpenCodeSessionFacade,
  MAX_SNAPSHOT_FILE_BYTES,
} from "../src/index";

interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
}

interface FakeResponses {
  readonly messages?: unknown[];
  readonly diff?: unknown[];
  readonly parentID?: string;
}

function fakeContext(responses: FakeResponses) {
  const calls: RecordedCall[] = [];
  const context = {
    session: {
      context: async (input: unknown) => {
        calls.push({ method: "session.context", input });
        return responses.messages ?? [];
      },
      get: async (input: unknown) => {
        calls.push({ method: "session.get", input });
        return {
          id: "ses_1",
          ...(responses.parentID === undefined ? {} : { parentID: responses.parentID }),
        };
      },
    },
    vcs: {
      diff: async (input: unknown) => {
        calls.push({ method: "vcs.diff", input });
        return { data: responses.diff ?? [] };
      },
    },
  } as unknown as AttributionContext;

  return { context, calls };
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "jevguard-facade-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("createOpenCodeSessionFacade", () => {
  test("maps session.context messages: text for inputs, completion for assistants", async () => {
    const { context, calls } = fakeContext({
      messages: [
        { id: "u1", type: "user", text: "task", time: { created: 1 } },
        { id: "s1", type: "synthetic", text: "queued", metadata: { a: 1 }, time: { created: 2 } },
        { id: "a1", type: "assistant", time: { created: 3, completed: 4 }, content: [] },
        { id: "a2", type: "assistant", time: { created: 5 }, content: [] },
        { id: "i1", type: "idle", outcome: "succeeded" },
      ],
    });

    const messages = await createOpenCodeSessionFacade(context, root).listMessages("ses_1");

    expect(calls).toEqual([{ method: "session.context", input: { sessionID: "ses_1" } }]);
    expect(messages).toEqual([
      { id: "u1", type: "user", completed: false, text: "task" },
      { id: "s1", type: "synthetic", completed: false, metadata: { a: 1 }, text: "queued" },
      { id: "a1", type: "assistant", completed: true },
      { id: "a2", type: "assistant", completed: false },
      { id: "i1", type: "idle", completed: false },
    ]);
  });

  test("reads the working diff with untracked files and keeps the truncation flag", async () => {
    const { context, calls } = fakeContext({
      diff: [
        { file: "a.ts", patch: "@@ a", additions: 1, deletions: 0, status: "modified" },
        { file: "b.ts", patch: "@@ b", additions: 1, deletions: 0, status: "added", more: true },
      ],
    });

    const diffs = await createOpenCodeSessionFacade(context, root).snapshotWorking();

    expect(calls).toEqual([{ method: "vcs.diff", input: { mode: "working", untracked: "files" } }]);
    expect(diffs).toEqual([
      { file: "a.ts", patch: "@@ a" },
      { file: "b.ts", patch: "@@ b", more: true },
    ]);
  });

  test("reads file contents under the root, marking missing and oversized files", async () => {
    await writeFile(join(root, "small.ts"), "export {};\n");
    await writeFile(join(root, "big.ts"), "x".repeat(MAX_SNAPSHOT_FILE_BYTES + 1));
    const { context } = fakeContext({});

    const contents = await createOpenCodeSessionFacade(context, root).readFiles([
      "small.ts",
      "big.ts",
      "gone.ts",
    ]);

    expect(contents.get("small.ts")).toEqual({ kind: "TEXT", text: "export {};\n" });
    expect(contents.get("big.ts")).toEqual({ kind: "OVERSIZED" });
    expect(contents.get("gone.ts")).toEqual({ kind: "MISSING" });
  });

  test("reads the parent session id or null", async () => {
    const child = fakeContext({ parentID: "ses_parent" });
    const top = fakeContext({});

    await expect(
      createOpenCodeSessionFacade(child.context, root).parentSessionID("ses_1"),
    ).resolves.toBe("ses_parent");
    await expect(
      createOpenCodeSessionFacade(top.context, root).parentSessionID("ses_1"),
    ).resolves.toBeNull();
  });

  test("propagates host failures", async () => {
    const context = {
      session: {
        context: async () => {
          throw new Error("network down");
        },
        get: async () => ({ id: "ses_1" }),
      },
      vcs: {
        diff: async () => {
          throw new Error("git failed");
        },
      },
    } as unknown as AttributionContext;
    const facade = createOpenCodeSessionFacade(context, root);

    await expect(facade.listMessages("ses_1")).rejects.toThrow("network down");
    await expect(facade.snapshotWorking()).rejects.toThrow("git failed");
  });
});
