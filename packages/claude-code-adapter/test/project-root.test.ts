import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
