import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { runGit } from "../src/capture/node-ports";
import { causesOf, HookWorld, initRepository } from "./hook-world";

vi.setConfig({ testTimeout: 20_000 });

let world: HookWorld;
/** The agent's own folder: where the session runs, and it is not a Git work tree. */
let workspace: string;

beforeEach(() => {
  world = new HookWorld();
  workspace = join(world.base, "workspace");
  mkdirSync(workspace, { recursive: true });
  world.environment.set("CLAUDE_PROJECT_DIR", workspace);
});

afterEach(() => {
  world.cleanup();
});

/** One tool event as the host sends it from the agent's folder. */
function fromWorkspace(
  name: string,
  tool: string,
  id: string,
  input: Record<string, unknown>,
): void {
  world.hook({
    hook_event_name: name,
    tool_name: tool,
    tool_use_id: id,
    tool_input: input,
    cwd: workspace,
  });
}

function editByAbsolutePath(path: string, content: string): void {
  const id = world.nextToolId();
  const input = { file_path: path };

  fromWorkspace("PreToolUse", "Write", id, input);
  writeFileSync(path, content);
  fromWorkspace("PostToolUse", "Write", id, input);
}

describe("a session that runs outside the repository it edits", () => {
  beforeEach(() => {
    initRepository(world.projectRoot);
  });

  test("an edit by absolute path is reviewed against that repository", () => {
    world.prompt("change the file in the repository");
    editByAbsolutePath(world.path("a.ts"), "one\r\ntwo\r\nTHREE\r\n");
    world.hook({
      hook_event_name: "Stop",
      background_tasks: [],
      stop_hook_active: false,
      cwd: workspace,
    });

    const handoff = world.onlyHandoff();

    expect(causesOf(handoff)).toEqual([]);
    expect(handoff.resolution.status).toBe("TURN");

    if (handoff.resolution.status !== "TURN") return;

    expect(handoff.resolution.turn.files.map((file) => file.path)).toEqual(["a.ts"]);
    expect(handoff.resolution.turn.files[0]?.patch).toContain("+THREE");
    expect(handoff.projectRoot).toBe(world.projectRoot);
  });

  test("a shell call made from the agent's folder is fenced where the unit is judged", () => {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.prompt("write from the workspace");
    editByAbsolutePath(world.path("keep.ts"), "keep\r\n");
    fromWorkspace("PreToolUse", "Bash", id, input);
    world.hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: input,
      cwd: workspace,
    });
    world.stop();

    expect(causesOf(world.onlyHandoff())).not.toContain("PROJECT_ROOT_UNRESOLVED");
  });

  test("a call from outside every work tree does not log GIT_FAILED on its own", () => {
    const id = world.nextToolId();

    world.prompt("call a tool from the workspace");
    fromWorkspace("PreToolUse", "mcp__agentes__read", id, {});
    world.hook({
      hook_event_name: "PostToolUse",
      tool_name: "mcp__agentes__read",
      tool_use_id: id,
      tool_input: {},
      cwd: workspace,
    });
    world.stop();

    const codes = world.hookLog().map((entry) => entry.code);

    expect(codes).not.toContain("GIT_FAILED");
    expect(causesOf(world.onlyHandoff())).toContain("PROJECT_ROOT_UNRESOLVED");
  });

  test("two repositories in one unit is UNAVAILABLE with its own reason", () => {
    const other = join(world.base, "other");

    initRepository(other);

    world.prompt("change two repositories");
    editByAbsolutePath(world.path("a.ts"), "one\r\ntwo\r\nTHREE\r\n");
    editByAbsolutePath(join(other, "a.ts"), "other\r\n");
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("MULTIPLE_REPOSITORIES");
  });
});

describe("a nested repository inside the unit's repository", () => {
  let inner: string;

  beforeEach(() => {
    initRepository(world.projectRoot);
    inner = join(world.projectRoot, "inner");
    initRepository(inner);
  });

  test("an edit in the nested repository is another repository, not the outer one", () => {
    world.prompt("change the outer file and the nested one");
    editByAbsolutePath(world.path("a.ts"), "one\r\ntwo\r\nTHREE\r\n");
    editByAbsolutePath(join(inner, "a.ts"), "inner\r\nCHANGED\r\n");
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("MULTIPLE_REPOSITORIES");
  });

  test("an edit in the nested repository the place cannot answer for is still another one", () => {
    // The nested repository is not safe for this user (on Windows a `rev-parse` there
    // exits 128), so the edit cannot prove which work tree holds it. It is not the outer
    // one either, and judging it by the outer repository's policy would be a silent pass.
    world.gitRunner = (args, cwd, options) =>
      args.includes("--show-toplevel") && resolve(cwd) === resolve(inner)
        ? { ok: false, failure: "EXIT" }
        : runGit(args, cwd, options);

    world.prompt("change the outer file and the nested one");
    editByAbsolutePath(world.path("a.ts"), "one\r\ntwo\r\nTHREE\r\n");
    editByAbsolutePath(join(inner, "a.ts"), "inner\r\nCHANGED\r\n");
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("MULTIPLE_REPOSITORIES");
  });

  test("an ordinary edit below the root makes no Git call to prove it", () => {
    mkdirSync(world.path("src"), { recursive: true });

    world.prompt("fix the root, then edit a plain folder");
    editByAbsolutePath(world.path("a.ts"), "one\r\ntwo\r\nTHREE\r\n");

    const asked: string[] = [];

    world.gitRunner = (args, cwd, options) => {
      if (args.includes("--show-toplevel")) asked.push(resolve(cwd));

      return runGit(args, cwd, options);
    };

    editByAbsolutePath(world.path("src", "b.ts"), "plain\r\n");
    world.stop();

    expect(asked).not.toContain(resolve(world.path("src")));
    expect(causesOf(world.onlyHandoff())).toEqual([]);
  });

  test("a shell call whose cwd cannot say where it ran leaves no proof", () => {
    const id = world.nextToolId();
    const input = { command: "write" };

    // The nested repository is not safe for this user (on Windows a `rev-parse` there
    // exits 128): the call cannot say whether it ran in the unit's repository.
    world.gitRunner = (args, cwd, options) =>
      args.includes("--show-toplevel") && resolve(cwd) === resolve(inner)
        ? { ok: false, failure: "EXIT" }
        : runGit(args, cwd, options);

    world.prompt("the root is the outer repository, the call runs in the nested one");
    editByAbsolutePath(world.path("a.ts"), "one\r\ntwo\r\nTHREE\r\n");
    world.hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: input,
      cwd: inner,
    });
    writeFileSync(join(inner, "a.ts"), "inner\r\nCHANGED\r\n");
    world.hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: input,
      cwd: inner,
    });
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("SHELL_GIT_DIFF_UNAVAILABLE");
  });

  test("a shell call from the agent's folder is still fenced at the unit's root", () => {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.prompt("edit the outer file, then call from the workspace");
    editByAbsolutePath(world.path("a.ts"), "one\r\ntwo\r\nTHREE\r\n");
    fromWorkspace("PreToolUse", "Bash", id, input);
    writeFileSync(world.path("keep.ts"), "keep\r\nCHANGED\r\n");
    fromWorkspace("PostToolUse", "Bash", id, input);
    world.stop();

    const handoff = world.onlyHandoff();

    expect(causesOf(handoff)).toEqual([]);
    expect(handoff.resolution.status).toBe("TURN");

    if (handoff.resolution.status !== "TURN") return;

    expect(handoff.resolution.turn.files.map((file) => file.path).sort()).toEqual([
      "a.ts",
      "keep.ts",
    ]);
  });
});

describe("a session inside a project that is not a work tree", () => {
  test("an edit inside the session's folder is still reviewed, as before", () => {
    world.environment.set("CLAUDE_PROJECT_DIR", world.projectRoot);
    world.prompt("edit a plain directory");

    const id = world.nextToolId();
    const input = { file_path: world.path("a.ts") };

    world.preTool("Write", id, input);
    world.write("a.ts", "plain\r\n");
    world.postTool("Write", id, input);
    world.stop();

    const handoff = world.onlyHandoff();

    expect(causesOf(handoff)).toEqual([]);
    expect(handoff.projectRoot).toBe(world.projectRoot);
    expect(handoff.resolution.status).toBe("TURN");
  });
});
