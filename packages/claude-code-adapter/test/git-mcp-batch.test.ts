import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runGit } from "../src/capture/node-ports";
import { DEFAULT_SHELL_DIFF_LIMITS } from "../src/capture/shell-diff-limits";
import { causesOf, HookWorld, initRepository } from "./hook-world";

// Real Git processes are slow under a loaded parallel run; only the time limits are relaxed (#72).
const LOADED_MACHINE_LIMITS = {
  ...DEFAULT_SHELL_DIFF_LIMITS,
  gitCallTimeoutMs: 60_000,
  timeMs: 60_000,
};

/** Number of Git snapshots taken so far: one `status --porcelain` each. */
const snapshots = { count: 0 };

vi.setConfig({ testTimeout: 20_000 });

describe("MCP calls fired in parallel", () => {
  let world: HookWorld;

  beforeEach(() => {
    world = new HookWorld();
    world.shellDiffLimits = LOADED_MACHINE_LIMITS;
    snapshots.count = 0;
    world.gitRunner = (args, cwd, options) => {
      if (args.includes("status")) snapshots.count += 1;

      return runGit(args, cwd, options);
    };
    initRepository(world.projectRoot);
  });

  afterEach(() => {
    world.cleanup();
  });

  /** Opens every call first, then writes once, then closes every call: the host's overlap. */
  function parallel(
    calls: readonly {
      readonly name: string;
      readonly id: string;
      readonly write?: () => void;
    }[],
  ): void {
    for (const call of calls) world.preTool(call.name, call.id, { command: "write" });

    for (const call of calls) call.write?.();

    for (const call of calls) world.postTool(call.name, call.id, { command: "write" });
  }

  function mcp(name: string, write?: () => void): { name: string; id: string; write?: () => void } {
    const id = world.nextToolId();

    return write === undefined ? { name, id } : { name, id, write };
  }

  test("two parallel calls changing different files are reviewed as one batch", () => {
    world.prompt("two servers at once");
    parallel([
      mcp("mcp__agentes__one", () => world.write("a.ts", "one\r\nTWO\r\n")),
      mcp("mcp__agentes__two", () => world.write("keep.ts", "KEEP\r\n")),
    ]);
    world.stop();

    const handoff = world.onlyHandoff();

    expect(causesOf(handoff)).toEqual([]);
    expect(handoff.shellCoverage).toEqual(["ADAPTER_GIT_DIFF"]);
    expect(handoff.resolution.status).toBe("TURN");

    if (handoff.resolution.status !== "TURN") return;

    expect(handoff.resolution.turn.files.map((file) => file.path).sort()).toEqual([
      "a.ts",
      "keep.ts",
    ]);
    expect(handoff.resolution.turn.files.find((file) => file.path === "keep.ts")?.patch).toContain(
      "-keep\r\n+KEEP\r\n",
    );
  });

  test("a resource tool that opens the batch with an mcp__agentes__ call is fenced with it", () => {
    world.prompt("resource tool first, server call second");
    parallel([
      mcp("ReadMcpResourceTool", () => world.write("a.ts", "one\r\nTWO\r\n")),
      mcp("mcp__agentes__one", () => world.write("keep.ts", "KEEP\r\n")),
    ]);
    world.stop();

    const handoff = world.onlyHandoff();

    expect(causesOf(handoff)).toEqual([]);
    expect(handoff.shellCoverage).toEqual(["ADAPTER_GIT_DIFF"]);
    expect(handoff.resolution.status).toBe("TURN");

    if (handoff.resolution.status !== "TURN") return;

    expect(handoff.resolution.turn.files.map((file) => file.path).sort()).toEqual([
      "a.ts",
      "keep.ts",
    ]);
    expect(snapshots.count).toBe(2);
  });

  test("a resource tool that joins an open mcp__agentes__ batch is fenced with it", () => {
    world.prompt("server call first, resource tool second");
    parallel([
      mcp("mcp__agentes__one", () => world.write("a.ts", "one\r\nTWO\r\n")),
      mcp("ReadMcpResourceTool", () => world.write("keep.ts", "KEEP\r\n")),
    ]);
    world.stop();

    const handoff = world.onlyHandoff();

    expect(causesOf(handoff)).toEqual([]);
    expect(handoff.shellCoverage).toEqual(["ADAPTER_GIT_DIFF"]);
    expect(handoff.resolution.status).toBe("TURN");

    if (handoff.resolution.status !== "TURN") return;

    expect(handoff.resolution.turn.files.map((file) => file.path).sort()).toEqual([
      "a.ts",
      "keep.ts",
    ]);
    expect(snapshots.count).toBe(2);
  });

  test("two parallel calls changing the same file net out to one change", () => {
    world.prompt("one file, two servers");
    parallel([
      mcp("mcp__agentes__one", () => world.write("a.ts", "one\r\nTWO\r\n")),
      mcp("mcp__agentes__two", () => world.write("a.ts", "one\r\nTWO\r\nTHREE\r\n")),
    ]);
    world.stop();

    const { resolution } = world.onlyHandoff();

    expect(resolution.status).toBe("TURN");

    if (resolution.status !== "TURN") return;

    expect(resolution.turn.files).toHaveLength(1);
    expect(resolution.turn.files[0]?.patch).toContain("+THREE\r\n");
    expect(resolution.turn.files[0]?.patch).not.toContain("-one");
  });

  test("three parallel calls are fenced by a single pair of snapshots", () => {
    world.prompt("three servers at once");
    parallel([
      mcp("mcp__agentes__one", () => world.write("a.ts", "one\r\nTWO\r\n")),
      mcp("mcp__agentes__two", () => world.write("keep.ts", "KEEP\r\n")),
      mcp("mcp__agentes__three"),
    ]);
    world.stop();

    expect(world.onlyHandoff().resolution.status).toBe("TURN");
    expect(snapshots.count).toBe(2);
  });

  test("a call that changes no file adds nothing to the batch", () => {
    world.prompt("one server writes, one only reads");
    parallel([mcp("mcp__agentes__read"), mcp("mcp__agentes__read_two")]);
    world.stop();

    expect(world.onlyHandoff().resolution).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("a shell call overlapping the batch leaves no proof", () => {
    const shellId = world.nextToolId();
    const mcpId = world.nextToolId();
    const input = { command: "write" };

    world.prompt("shell and server at once");
    world.preTool("Bash", shellId, input);
    world.preTool("mcp__agentes__one", mcpId, input);
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("Bash", shellId, input);
    world.postTool("mcp__agentes__one", mcpId, input);
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("SHELL_GIT_DIFF_UNAVAILABLE");
  });

  test("an edit inside the batch window leaves no proof", () => {
    const editId = world.nextToolId();
    const first = world.nextToolId();
    const second = world.nextToolId();
    const input = { command: "write" };
    const editInput = { file_path: world.path("keep.ts") };

    world.prompt("edit between two servers");
    world.preTool("mcp__agentes__one", first, input);
    world.preTool("Write", editId, editInput);
    world.write("keep.ts", "EDITED\r\n");
    world.postTool("Write", editId, editInput);
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("mcp__agentes__one", first, input);
    world.preTool("mcp__agentes__two", second, input);
    world.postTool("mcp__agentes__two", second, input);
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("SHELL_GIT_DIFF_UNAVAILABLE");
  });

  test("a member without its Post leaves the batch without proof", () => {
    const first = world.nextToolId();
    const second = world.nextToolId();
    const input = { command: "write" };

    world.prompt("one server never closes");
    world.preTool("mcp__agentes__one", first, input);
    world.preTool("mcp__agentes__two", second, input);
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("mcp__agentes__one", first, input);
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("PAIRING_BROKEN");
  });

  test("a batch that changes nothing is skipped, not unavailable", () => {
    world.write("a.ts", "dirty\r\n");
    world.prompt("servers only read");
    parallel([mcp("mcp__agentes__one"), mcp("mcp__agentes__two")]);
    world.stop();

    expect(world.onlyHandoff().resolution).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("a member that arrives before the base snapshot is on disk leaves no proof", () => {
    const base = world.nextToolId();
    const late = world.nextToolId();
    const input = { command: "write" };
    let injected = false;

    // The hook processes share no lock: the second Pre runs while the first snapshot is
    // still being taken, and its server writes before that picture is complete.
    world.gitRunner = (args, cwd, options) => {
      if (!injected && args.includes("status")) {
        injected = true;
        world.preTool("mcp__agentes__two", late, input);
        world.write("keep.ts", "KEEP_BY_B\r\n");
      }

      if (args.includes("status")) snapshots.count += 1;

      return runGit(args, cwd, options);
    };

    world.prompt("one server starts during the base picture");
    world.preTool("mcp__agentes__one", base, input);
    world.postTool("mcp__agentes__one", base, input);
    world.postTool("mcp__agentes__two", late, input);
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("SHELL_GIT_DIFF_UNAVAILABLE");
  });

  test("a member that fails still lets the batch close with the other's change", () => {
    const failed = world.nextToolId();
    const closing = world.nextToolId();
    const input = { command: "write" };

    world.prompt("one server fails, the other writes");
    world.preTool("mcp__agentes__one", failed, input);
    world.preTool("mcp__agentes__two", closing, input);
    world.write("a.ts", "one\r\nTWO\r\n");
    world.write("keep.ts", "KEEP\r\n");
    world.failTool("mcp__agentes__one", failed, input);
    world.postTool("mcp__agentes__two", closing, input);
    world.stop();

    const { resolution } = world.onlyHandoff();

    expect(resolution.status).toBe("TURN");

    if (resolution.status !== "TURN") return;

    expect(resolution.turn.files.map((file) => file.path).sort()).toEqual(["a.ts", "keep.ts"]);
  });

  test("a batch whose last member fails still carries the batch's diff", () => {
    const closing = world.nextToolId();
    const failed = world.nextToolId();
    const input = { command: "write" };

    world.prompt("the closing server fails after writing");
    world.preTool("mcp__agentes__one", closing, input);
    world.preTool("mcp__agentes__two", failed, input);
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("mcp__agentes__one", closing, input);
    world.failTool("mcp__agentes__two", failed, input);
    world.stop();

    const { resolution } = world.onlyHandoff();

    expect(resolution.status).toBe("TURN");

    if (resolution.status !== "TURN") return;

    expect(resolution.turn.files.map((file) => file.path)).toEqual(["a.ts"]);
  });

  test("a call that starts after the batch closed fences itself", () => {
    world.prompt("one after the other");
    parallel([mcp("mcp__agentes__one", () => world.write("a.ts", "one\r\nTWO\r\n"))]);
    parallel([mcp("mcp__agentes__two", () => world.write("keep.ts", "KEEP\r\n"))]);
    world.stop();

    const { resolution } = world.onlyHandoff();

    expect(resolution.status).toBe("TURN");

    if (resolution.status !== "TURN") return;

    expect(resolution.turn.files.map((file) => file.path).sort()).toEqual(["a.ts", "keep.ts"]);
    expect(snapshots.count).toBe(4);
  });
});
