import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ClaudeReviewHandoff } from "../src/hook";
import { createFileHandoffSink } from "../src/hook";
import { backdate, causesOf, HookWorld, initRepository, SESSION } from "./hook-world";

const MARKER = "SECRET_MARKER_4821";

let world: HookWorld;

beforeEach(() => {
  world = new HookWorld();
});

afterEach(() => {
  world.cleanup();
  vi.restoreAllMocks();
});

function patchOf(handoff: ClaudeReviewHandoff): string {
  if (handoff.resolution.status !== "TURN")
    throw new Error(`expected TURN, got ${handoff.resolution.status}`);

  return handoff.resolution.turn.files.map((file) => file.patch).join("\n");
}

describe("runHook is silent and contained", () => {
  test("never throws or writes to stdout/stderr on bad input or bad state", () => {
    const stdout = vi.spyOn(process.stdout, "write");
    const stderr = vi.spyOn(process.stderr, "write");
    const valid = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: "/x" });
    const inputs = [
      "{not json",
      "[1,2]",
      '"text"',
      "null",
      JSON.stringify({ hook_event_name: "Weird", session_id: "s", cwd: "/x" }),
      valid,
    ];

    for (const input of inputs) expect(() => world.raw(input)).not.toThrow();

    const blocker = join(world.base, "state-is-a-file");

    writeFileSync(blocker, "a file, not a directory");
    world.environment.set("CLAUDE_PLUGIN_DATA", blocker);

    for (const input of inputs) expect(() => world.raw(input)).not.toThrow();

    world.environment.delete("CLAUDE_PLUGIN_DATA");

    for (const input of inputs) expect(() => world.raw(input)).not.toThrow();

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });

  test("the log holds closed codes only, never payload content", () => {
    world.raw(
      JSON.stringify({ hook_event_name: "Weird", session_id: MARKER, cwd: MARKER, prompt: MARKER }),
    );
    world.raw(`{"prompt": "${MARKER}"`);
    world.hook({ hook_event_name: "PreToolUse", tool_name: MARKER });

    const log = world.hookLog();
    const text = JSON.stringify(log);

    expect(log.length).toBe(3);
    expect(text).not.toContain(MARKER);
    expect(log.map((entry) => Object.keys(entry).sort())).toEqual([
      ["code", "event", "timestamp"],
      ["code", "event", "timestamp"],
      ["code", "event", "timestamp"],
    ]);
    expect(log.map((entry) => entry.code)).toEqual([
      "PARSE_FAILED:UNKNOWN_EVENT",
      "PARSE_FAILED:NOT_AN_OBJECT",
      "PARSE_FAILED:MISSING_FIELD",
    ]);
  });

  test("bounds the log file", () => {
    const file = join(world.stateDirectory(), "hook-log.jsonl");
    const nearLimit = `${"x".repeat(99)}\n`.repeat(Math.ceil((256 * 1024) / 100));

    mkdirSync(world.stateDirectory(), { recursive: true });
    writeFileSync(file, nearLimit);
    world.raw("{bad");

    const size = readFileSync(file).length;

    expect(size).toBeLessThanOrEqual(256 * 1024);
    expect(size).toBeLessThan(nearLimit.length);
  });
});

describe("edit flow", () => {
  test("Write is attributed end to end and the unit state is gone afterwards", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("rewrite a.ts");
    world.edit("src/a.ts", "new\n");
    world.stop();

    const handoff = world.onlyHandoff();

    expect(handoff.resolution.status).toBe("TURN");
    expect(patchOf(handoff)).toContain("-old\n+new\n");
    expect(handoff).toMatchObject({
      version: 1,
      ordinal: 0,
      sessionId: SESSION,
      projectRoot: world.projectRoot,
      closedAt: "2026-10-05T12:00:00.000Z",
      turnId: expect.stringMatching(new RegExp(`^claude-code:${SESSION}:[0-9a-f]{16}:0$`)),
      epoch: expect.stringMatching(/^[0-9a-f]{16}$/),
      shellCoverage: [],
    });
    expect(existsSync(world.unitDirectory(0))).toBe(false);
    expect(readdirSync(world.sessionDirectory())).toEqual(["current", "epoch", "units"]);
    expect(readFileSync(join(world.sessionDirectory(), "current"), "utf8")).toBe("1");
  });

  test("measures the jsdiff latency at the Stop with a 1 MiB file", () => {
    const lines = Array.from(
      { length: 19_000 },
      (_, index) => `line ${String(index).padStart(6, "0")} ${"x".repeat(40)}\n`,
    );
    const before = lines.join("");
    const after = lines
      .map((line, index) => (index % 5000 === 0 ? `changed ${index}\n` : line))
      .join("");

    expect(Buffer.byteLength(before)).toBeGreaterThan(1_000_000);
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(1024 * 1024);

    world.write("big.ts", before);
    world.prompt("edit the big file");
    world.edit("big.ts", after);

    const started = performance.now();

    world.stop();

    const elapsedMs = performance.now() - started;

    console.info(`jsdiff-latency-1MiB-typical-edit: ${elapsedMs.toFixed(0)} ms`);
    expect(patchOf(world.onlyHandoff())).toContain("+changed 5000");
  });

  test("the first Pre of a path wins", () => {
    world.write("src/a.ts", "v0\n");
    world.prompt("edit twice");
    world.edit("src/a.ts", "v1\n");
    world.edit("src/a.ts", "v2\n", "Edit");
    world.stop();

    const patch = patchOf(world.onlyHandoff());

    expect(patch).toContain("-v0\n+v2\n");
    expect(patch).not.toContain("v1");
  });

  test("a new file has an absent pre-image", () => {
    world.prompt("create a file");
    world.edit("src/new.ts", "created\n");
    world.stop();

    expect(patchOf(world.onlyHandoff())).toContain("--- /dev/null");
  });

  test("a change after the Post and before the Stop is an unattributed writer", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("edit");
    world.edit("src/a.ts", "new\n");
    world.write("src/a.ts", "tampered\n");
    world.stop();

    const handoff = world.onlyHandoff();

    expect(handoff.resolution.status).toBe("UNAVAILABLE");
    expect(causesOf(handoff)).toEqual(["UNATTRIBUTED_WRITER"]);
  });
});

describe("no-read first", () => {
  test("blocked paths never reach the file reader and the unit is BLOCKED_EVIDENCE", () => {
    world.write(".env", "TOKEN=1\n");
    world.write("data.bin", "binary");
    world.reads.length = 0;
    world.prompt("touch secrets");
    world.edit(".env", "TOKEN=2\n");
    world.edit("data.bin", "other");
    world.stop();

    const handoff = world.onlyHandoff();
    const touched = world.reads.filter(
      (path) => path.includes(".env") || path.includes("data.bin"),
    );

    expect(touched).toEqual([]);
    expect(handoff.resolution).toMatchObject({ status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" });
    expect(causesOf(handoff)).toEqual(["BLOCKED_PATH"]);
  });

  test("a path outside the project root is PATH_OUTSIDE_REPOSITORY and unread", () => {
    const outside = join(world.base, "elsewhere.ts");

    writeFileSync(outside, "x");
    world.reads.length = 0;
    world.prompt("edit elsewhere");

    const id = world.nextToolId();

    world.preTool("Write", id, { file_path: outside });
    world.postTool("Write", id, { file_path: outside });
    world.stop();

    expect(world.reads.filter((path) => path.includes("elsewhere"))).toEqual([]);
    expect(causesOf(world.onlyHandoff())).toContain("PATH_OUTSIDE_REPOSITORY");
  });
});

describe("closure", () => {
  test("a Stop with active background tasks does not close; the next empty Stop does, once", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("work");
    world.edit("src/a.ts", "new\n");
    world.stop([{ id: "bg1" }]);

    expect(world.handoffs()).toEqual([]);

    world.stop();

    const handoff = world.onlyHandoff();

    expect(handoff.resolution.status).toBe("TURN");
    expect(patchOf(handoff)).toContain("+new");
  });

  test("a subagent Stop never closes the unit", () => {
    world.prompt("delegate");
    world.hook({ hook_event_name: "Stop", agent_id: "sub1", background_tasks: [] });

    expect(world.handoffs()).toEqual([]);
  });

  test("StopFailure closes as TURN_FAILED", () => {
    world.prompt("fail");
    world.stopFailure();

    const handoff = world.onlyHandoff();

    expect(handoff.resolution).toMatchObject({ status: "UNAVAILABLE" });
    expect(causesOf(handoff)).toEqual(["TURN_FAILED"]);
  });

  test("two closures yield ordinals 0 and 1 with distinct turn ids", () => {
    world.write("src/a.ts", "a0\n");
    world.prompt("first");
    world.edit("src/a.ts", "a1\n");
    world.stop();
    world.prompt("second");
    world.edit("src/a.ts", "a2\n");
    world.stop();

    const [first, second] = world.handoffs();

    expect([first?.ordinal, second?.ordinal]).toEqual([0, 1]);
    expect(first?.turnId).not.toBe(second?.turnId);
    expect(first && patchOf(first)).toContain("-a0\n+a1\n");
    expect(second && patchOf(second)).toContain("-a1\n+a2\n");
  });

  test("a Stop without any prompt is MISSING_PROMPT", () => {
    world.stop();

    expect(causesOf(world.onlyHandoff())).toEqual(["MISSING_PROMPT"]);
  });

  test("a prompt without writes is SKIPPED", () => {
    world.prompt("just talk");
    world.stop();

    expect(world.onlyHandoff().resolution).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("a changed project root taints the unit", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("move");
    world.environment.set("CLAUDE_PROJECT_DIR", join(world.base, "other"));
    world.edit("src/a.ts", "new\n");
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("CAPTURE_FAILED");
  });
});

describe("taint", () => {
  test("an unparsable event of an identifiable session taints its unit", () => {
    world.prompt("work");
    world.hook({ hook_event_name: "PreToolUse", tool_name: "Write" });
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("CAPTURE_FAILED");
  });

  test("a corrupted events line makes the unit CAPTURE_FAILED", () => {
    world.prompt("work");
    writeFileSync(join(world.unitDirectory(), "events.jsonl"), "garbage\n", { flag: "a" });
    world.stop();

    const handoff = world.onlyHandoff();

    expect(handoff.resolution).toMatchObject({ status: "UNAVAILABLE" });
    expect(causesOf(handoff)).toEqual(["CAPTURE_FAILED"]);
  });

  test("a blob whose digest no longer matches is CAPTURE_FAILED", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("work");
    world.edit("src/a.ts", "new\n");

    const blobs = join(world.unitDirectory(), "blobs");
    const [blob] = readdirSync(blobs);

    writeFileSync(join(blobs, blob ?? ""), "tampered");
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("CAPTURE_FAILED");
  });

  test("an unreadable current marker is rebuilt and taints the unit", () => {
    world.prompt("one");
    world.stop();
    writeFileSync(join(world.sessionDirectory(), "current"), "not a number");
    world.prompt("two");
    world.stop();

    const handoffs = world.handoffs();

    expect(handoffs).toHaveLength(2);
    expect(handoffs[0]?.ordinal).toBe(0);
    expect(handoffs[1]?.ordinal).toBeGreaterThan(1);
    expect(causesOf(handoffs[1] as ClaudeReviewHandoff)).toContain("CAPTURE_FAILED");
  });
});

describe("content limits", () => {
  test("a file over 1 MiB is CONTENT_TOO_LARGE", () => {
    world.write("big.ts", "x".repeat(1024 * 1024 + 1));
    world.prompt("edit big");
    world.edit("big.ts", "small\n");
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("CONTENT_TOO_LARGE");
  });

  test("exactly 1 MiB is accepted", () => {
    world.write("edge.ts", "x".repeat(1024 * 1024));
    world.prompt("edit edge");
    world.edit("edge.ts", "small\n");
    world.stop();

    expect(world.onlyHandoff().resolution.status).toBe("TURN");
  });

  test.each([
    ["invalid UTF-8", Uint8Array.of(0xff, 0xfe, 0x41)],
    ["a NUL byte", Uint8Array.of(0x41, 0x00, 0x42)],
  ])("%s is CONTENT_NOT_TEXT", (_label, bytes) => {
    world.write("odd.ts", bytes);
    world.prompt("edit odd");
    world.edit("odd.ts", "text\n");
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("CONTENT_NOT_TEXT");
  });
});

describe("Bash with a real repository", () => {
  test("a Bash write is reviewed from the Git diff and records the coverage", () => {
    initRepository(world.projectRoot);
    world.prompt("edit through Bash");

    const id = world.nextToolId();

    world.preTool("Bash", id, { command: "sed" });
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("Bash", id, { command: "sed" }, { stdout: "" });
    world.stop();

    const handoff = world.onlyHandoff();

    expect(handoff.shellCoverage).toEqual(["ADAPTER_GIT_DIFF"]);
    expect(patchOf(handoff)).toContain("-two\r\n+TWO\r\n");
  });

  test("outside a Git repository Bash is SHELL_GIT_DIFF_UNAVAILABLE", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("run bash");

    const id = world.nextToolId();

    world.preTool("Bash", id, { command: "echo" });
    world.postTool("Bash", id, { command: "echo" }, { stdout: "" });
    world.stop();

    expect(causesOf(world.onlyHandoff())).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });
});

describe("cleanup", () => {
  test("SessionEnd deletes the session state", () => {
    world.prompt("work");

    expect(existsSync(world.sessionDirectory())).toBe(true);

    world.hook({ hook_event_name: "SessionEnd" });

    expect(existsSync(world.sessionDirectory())).toBe(false);
  });

  test("a sweep removes sessions and handoffs older than 24 hours and keeps recent ones", () => {
    world.prompt("stale");
    world.hook({ hook_event_name: "UserPromptSubmit", session_id: "recent", prompt: "recent" });
    mkdirSync(world.handoffDirectory(), { recursive: true });

    const oldHandoff = join(world.handoffDirectory(), "old.json");
    const freshHandoff = join(world.handoffDirectory(), "fresh.json");

    writeFileSync(oldHandoff, "{}");
    writeFileSync(freshHandoff, "{}");
    backdate(world.sessionDirectory(), 30, world.clock);
    backdate(oldHandoff, 25, world.clock);
    backdate(freshHandoff, 23, world.clock);
    world.hook({ hook_event_name: "SessionStart", session_id: "starter" });

    expect(existsSync(world.sessionDirectory())).toBe(false);
    expect(existsSync(world.sessionDirectory("recent"))).toBe(true);
    expect(existsSync(oldHandoff)).toBe(false);
    expect(existsSync(freshHandoff)).toBe(true);
  });
});

describe("handoff sink", () => {
  test("a second delivery with the same id never overwrites the first", () => {
    const sink = createFileHandoffSink(world.handoffDirectory());
    const base: ClaudeReviewHandoff = {
      version: 1,
      turnId: "claude-code:s:0123456789abcdef:0",
      epoch: "0123456789abcdef",
      sessionId: "s",
      ordinal: 0,
      projectRoot: "/p",
      closedAt: "2026-10-05T00:00:00.000Z",
      shellCoverage: [],
      resolution: { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" },
    };

    expect(sink.deliver(base)).toBe("CREATED");
    expect(sink.deliver({ ...base, closedAt: "2030-01-01T00:00:00.000Z" })).toBe("EXISTS");

    const files = readdirSync(world.handoffDirectory());

    expect(files).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(world.handoffDirectory(), files[0] ?? ""), "utf8")),
    ).toEqual(base);
  });
});
