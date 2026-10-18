import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_CAPTURED_FILE_BYTES } from "../src/capture/file-image";
import { runGit } from "../src/capture/node-ports";
import { DEFAULT_SHELL_DIFF_LIMITS } from "../src/capture/shell-diff-limits";
import { causesOf, git, HookWorld, initRepository } from "./hook-world";

const SECRET_CONTENT = "SHELL_LIMIT_SECRET_4471";

function currentBranch(root: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function currentCommit(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function shellFiles(world: HookWorld): readonly string[] {
  const directory = join(world.unitDirectory(), "shell");

  return existsSync(directory) ? readdirSync(directory) : [];
}

// Real Git processes are slow under a loaded parallel run; keep these from timing out spuriously.
vi.setConfig({ testTimeout: 20_000 });

describe.each(["Bash", "PowerShell"])("%s through the hook", (tool) => {
  let world: HookWorld;

  beforeEach(() => {
    world = new HookWorld();
    initRepository(world.projectRoot);
  });

  afterEach(() => {
    world.cleanup();
  });

  function shell(change: () => void, fail = false): void {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.preTool(tool, id, input);
    change();

    if (fail) world.failTool(tool, id, input);
    else world.postTool(tool, id, input);
  }

  test("is captured by default and reviewed against the CRLF HEAD image", () => {
    world.prompt("rewrite with the shell");
    shell(() => world.write("a.ts", "one\r\nTWO\r\n"));
    world.stop();

    const handoff = world.onlyHandoff();

    expect(handoff.shellCoverage).toEqual(["ADAPTER_GIT_DIFF"]);
    expect(handoff.resolution.status).toBe("TURN");

    if (handoff.resolution.status !== "TURN") return;

    const [file] = handoff.resolution.turn.files;

    expect(file?.path).toBe("a.ts");
    expect(file?.patch).toContain("-two\r\n+TWO\r\n");
    expect(file?.patch).not.toContain("-one");
  });

  test("a failed call keeps its Git diff and is not a reason", () => {
    world.prompt("fail after writing");
    shell(() => world.write("a.ts", "one\r\nTWO\r\n"), true);
    world.stop();

    expect(world.onlyHandoff().resolution.status).toBe("TURN");
  });

  test("a dirty file rewritten by the shell is reviewed against its pre-call content", () => {
    world.write("a.ts", "dirty\r\n");
    world.prompt("touch a dirty file");
    shell(() => world.write("a.ts", "dirtier\r\n"));
    world.stop();

    const { resolution } = world.onlyHandoff();

    expect(resolution.status).toBe("TURN");

    if (resolution.status !== "TURN") return;

    const [file] = resolution.turn.files;

    expect(file?.patch).toContain("-dirty\r\n+dirtier\r\n");
    expect(file?.patch).not.toContain("-one");
  });

  test("the Pre snapshot is deleted after the Post", () => {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.write("a.ts", "dirty\r\n");
    world.prompt("touch a dirty file");
    world.preTool(tool, id, input);

    expect(
      shellFiles(world)
        .map((name) => name.split(".").pop())
        .sort(),
    ).toEqual(["json", "pack"]);

    world.write("a.ts", "dirtier\r\n");
    world.postTool(tool, id, input);

    expect(shellFiles(world)).toEqual([]);
  });

  test("the kill switch leaves the shell without a diff", () => {
    world.environment.set("JEVGUARD_CLAUDE_SHELL_GIT_DIFF", "0");
    world.prompt("rewrite with the shell");
    shell(() => world.write("a.ts", "one\r\nTWO\r\n"));
    world.stop();

    expect(causesOf(world.onlyHandoff())).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });

  test("the retired PowerShell switch name does nothing", () => {
    world.environment.set("JEVGUARD_CLAUDE_POWERSHELL_GIT_DIFF", "0");
    world.prompt("rewrite with the shell");
    shell(() => world.write("a.ts", "one\r\nTWO\r\n"));
    world.stop();

    expect(world.onlyHandoff().resolution.status).toBe("TURN");
  });

  test("any other value of the switch keeps the capture on", () => {
    world.environment.set("JEVGUARD_CLAUDE_SHELL_GIT_DIFF", "1");
    world.prompt("rewrite with the shell");
    shell(() => world.write("a.ts", "one\r\nTWO\r\n"));
    world.stop();

    expect(world.onlyHandoff().resolution.status).toBe("TURN");
  });

  test("a concurrent write-capable call during the window is unproven", () => {
    const shellId = world.nextToolId();
    const edit = world.nextToolId();
    const shellInput = { command: "write" };
    const editInput = { file_path: world.path("keep.ts") };

    world.prompt("overlap");
    world.preTool(tool, shellId, shellInput);
    world.preTool("Write", edit, editInput);
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool(tool, shellId, shellInput);
    world.postTool("Write", edit, editInput);
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("SHELL_GIT_DIFF_UNAVAILABLE");
  });

  test("a call already pending when the shell starts is unproven", () => {
    const shellId = world.nextToolId();
    const edit = world.nextToolId();
    const shellInput = { command: "write" };
    const editInput = { file_path: world.path("keep.ts") };

    world.prompt("overlap");
    world.preTool("Write", edit, editInput);
    world.preTool(tool, shellId, shellInput);
    world.postTool(tool, shellId, shellInput);
    world.postTool("Write", edit, editInput);
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("SHELL_GIT_DIFF_UNAVAILABLE");
  });

  test("a commit of a file dirty before the prompt leaves nothing to review", () => {
    world.write("a.ts", "dirty\r\n");
    world.prompt("commit");
    shell(() => git(world.projectRoot, "commit", "-q", "-am", "inside"));
    world.stop();

    expect(world.onlyHandoff().resolution).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("a switch and a fast-forward merge across calls net out to nothing", () => {
    const base = currentBranch(world.projectRoot);

    git(world.projectRoot, "switch", "-q", "-c", "feature");
    world.write("a.ts", "branch\r\n");
    git(world.projectRoot, "commit", "-q", "-am", "feature");
    world.prompt("move around");
    shell(() => git(world.projectRoot, "switch", "-q", base));
    shell(() => git(world.projectRoot, "merge", "-q", "--ff-only", "feature"));
    world.stop();

    expect(world.onlyHandoff().resolution).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("a commit, a switch and a merge in one call that net out leave nothing to review", () => {
    const base = currentBranch(world.projectRoot);
    const origin = currentCommit(world.projectRoot);

    world.prompt("rewrite history");
    shell(() => {
      git(world.projectRoot, "switch", "-q", "-c", "feature");
      world.write("a.ts", "branch\r\n");
      git(world.projectRoot, "commit", "-q", "-am", "feature");
      git(world.projectRoot, "switch", "-q", base);
      git(world.projectRoot, "merge", "-q", "--ff-only", "feature");
      git(world.projectRoot, "reset", "-q", "--hard", origin);
    });
    world.stop();

    expect(world.onlyHandoff().resolution).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("a checkout of files dirty before the prompt is reviewed back to the committed content", () => {
    world.write("a.ts", "dirty-a\r\n");
    world.write("keep.ts", "dirty-keep\r\n");
    world.prompt("discard my changes");
    shell(() => git(world.projectRoot, "checkout", "-q", "--", "a.ts", "keep.ts"));
    world.stop();

    const { resolution } = world.onlyHandoff();

    expect(resolution.status).toBe("TURN");

    if (resolution.status !== "TURN") return;

    expect(resolution.turn.files.map((file) => file.path)).toEqual(["a.ts", "keep.ts"]);
    expect(resolution.turn.files[0]?.patch).toContain("-dirty-a\r\n+one\r\n+two\r\n");
    expect(resolution.turn.files[1]?.patch).toContain("-dirty-keep\r\n+keep\r\n");
  });
});

describe("shell diff limits through the hook", () => {
  let world: HookWorld;
  let gitCalls: string[];

  beforeEach(() => {
    world = new HookWorld();
    gitCalls = [];
    initRepository(world.projectRoot);
    world.shellDiffLimits = { ...DEFAULT_SHELL_DIFF_LIMITS, maxStatusEntries: 2 };
    world.gitRunner = (args, cwd, options) => {
      gitCalls.push(args.find((arg) => !arg.startsWith("--")) ?? "");

      return runGit(args, cwd, options);
    };
  });

  afterEach(() => {
    world.cleanup();
  });

  function bash(beforeCall: () => void): void {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.prompt("rewrite with the shell");
    beforeCall();
    world.preTool("Bash", id, input);
    gitCalls.length = 0;
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("Bash", id, input);
    world.stop();
  }

  function dirty(count: number): void {
    for (let index = 0; index < count; index += 1) {
      world.write(`dirty${index}.ts`, `${SECRET_CONTENT}${index}\n`);
    }
  }

  test("a Pre over the limit makes the unit unavailable and the Post takes no snapshot", () => {
    bash(() => dirty(3));

    const handoff = world.onlyHandoff();
    const limitLogs = world
      .hookLog()
      .filter((entry) => entry.code === "SHELL_DIFF_LIMIT:STATUS_ENTRIES");

    expect(handoff.resolution.status).toBe("UNAVAILABLE");
    expect(causesOf(handoff)).toEqual(["SHELL_DIFF_LIMIT_EXCEEDED"]);
    expect(limitLogs).toHaveLength(1);
    expect(gitCalls).not.toContain("status");
    expect(world.byteReads).toEqual([]);
    expect(JSON.stringify(handoff)).not.toContain(SECRET_CONTENT);
    expect(JSON.stringify(world.hookLog())).not.toContain(SECRET_CONTENT);
  });

  test("a dirty file larger than the snapshot budget is UNAVAILABLE with a limit reason", () => {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.shellDiffLimits = { ...DEFAULT_SHELL_DIFF_LIMITS, maxContentBytes: 20 };
    world.write("a.ts", `${SECRET_CONTENT}\n`);
    world.prompt("rewrite the dirty file");
    world.preTool("Bash", id, input);

    expect(shellFiles(world).filter((name) => name.endsWith(".pack"))).toEqual([]);

    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("Bash", id, input);
    world.stop();

    const handoff = world.onlyHandoff();

    expect(causesOf(handoff)).toEqual(["SHELL_DIFF_LIMIT_EXCEEDED"]);
    expect(
      world.hookLog().filter((entry) => entry.code === "SHELL_DIFF_LIMIT:CONTENT_BYTES"),
    ).toHaveLength(1);
    expect(shellFiles(world)).toEqual([]);
    expect(JSON.stringify(handoff)).not.toContain(SECRET_CONTENT);
    expect(JSON.stringify(world.hookLog())).not.toContain(SECRET_CONTENT);
  });

  test("a dirty file over 1 MiB changed by the shell is CONTENT_TOO_LARGE", () => {
    bash(() => world.write("a.ts", "a".repeat(MAX_CAPTURED_FILE_BYTES + 1)));

    expect(causesOf(world.onlyHandoff())).toEqual(["CONTENT_TOO_LARGE"]);
  });

  test("within the limit the call is still reviewed", () => {
    bash(() => dirty(1));

    expect(causesOf(world.onlyHandoff())).not.toContain("SHELL_DIFF_LIMIT_EXCEEDED");
  });
});

describe("Bash host diff cross-check", () => {
  let world: HookWorld;

  beforeEach(() => {
    world = new HookWorld();
    initRepository(world.projectRoot);
  });

  afterEach(() => {
    world.cleanup();
  });

  function bash(response: unknown): void {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.prompt("cross-check");
    world.preTool("Bash", id, input);
    world.write("a.ts", "one\r\nTWO\r\n");
    world.postTool("Bash", id, input, response);
    world.stop();
  }

  function codes(): readonly unknown[] {
    return world
      .hookLog()
      .map((entry) => entry.code)
      .filter((code) => String(code).startsWith("SHELL_CROSS_CHECK"));
  }

  test.each([
    ["agrees", { bashEditDiff: { changedFiles: ["a.ts"] } }, "SHELL_CROSS_CHECK_AGREE"],
    ["disagrees", { bashEditDiff: { changedFiles: ["keep.ts"] } }, "SHELL_CROSS_CHECK_DISAGREE"],
  ])("a host diff that %s is logged and never changes the outcome", (_label, response, code) => {
    bash(response);

    expect(codes()).toEqual([code]);
    expect(world.onlyHandoff().resolution.status).toBe("TURN");
  });

  test("an absent host diff (setting off) logs nothing and never changes the outcome", () => {
    bash({ stdout: "" });

    expect(codes()).toEqual([]);
    expect(world.onlyHandoff().resolution.status).toBe("TURN");
  });
});
