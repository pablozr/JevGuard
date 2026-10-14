import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UNLIMITED_BUDGET } from "../src/capture/budget";
import { createRepoPathResolver, sha256Hex } from "../src/capture/file-image";
import { diffGitSnapshots, takeGitSnapshot } from "../src/capture/git-shell";
import { createNodeFileReader, runGit } from "../src/capture/node-ports";
import { createShellDiffMeter, DEFAULT_SHELL_DIFF_LIMITS } from "../src/capture/shell-diff-limits";
import type { GitShellContext } from "../src/capture/types";
import { causesOf, git, HookWorld, initRepository, ORIGINAL, takenSnapshot } from "./hook-world";

const SECRET_CONTENT = "SHELL_LIMIT_SECRET_4471";

// Real Git processes are slow under a loaded parallel run; keep these from timing out spuriously.
vi.setConfig({ testTimeout: 20_000 });

describe("Git shell diff", () => {
  let base: string;
  let root: string;
  let reads: string[];
  let context: GitShellContext;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "jevguard-git-")));
    root = join(base, "repo");
    reads = [];

    const files = createNodeFileReader();

    initRepository(root);
    context = {
      git: runGit,
      projectRoot: root,
      budget: UNLIMITED_BUDGET,
      files: {
        ...files,
        stat: (path) => files.stat(path),
        readBytes: (path, maxBytes) => {
          reads.push(path);
          return files.readBytes(path, maxBytes);
        },
      },
      resolveRepoPath: createRepoPathResolver(root),
      limits: DEFAULT_SHELL_DIFF_LIMITS,
      meter: createShellDiffMeter(DEFAULT_SHELL_DIFF_LIMITS),
    };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function window(act: () => void, projectContext = context) {
    const pre = takenSnapshot(takeGitSnapshot(projectContext, root));

    act();

    const post = takenSnapshot(takeGitSnapshot(projectContext, root));

    return diffGitSnapshots(projectContext, pre, post);
  }

  test("a modified clean file is CLEAN with the index image byte for byte, CRLF included", () => {
    const changed = "one\r\nTWO\r\n";
    const result = window(() => writeFileSync(join(root, "a.ts"), changed));

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "CLEAN",
          indexImage: { state: "PRESENT", digest: sha256Hex(ORIGINAL), content: ORIGINAL },
          post: { state: "PRESENT", digest: sha256Hex(changed) },
        },
      ],
    });
  });

  test("a new untracked file is CLEAN with an absent index image", () => {
    const result = window(() => writeFileSync(join(root, "new.ts"), "fresh\n"));

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "new.ts",
          preState: "CLEAN",
          indexImage: { state: "ABSENT" },
          post: { state: "PRESENT", digest: sha256Hex("fresh\n") },
        },
      ],
    });
  });

  test("a deleted tracked file has an absent post", () => {
    const result = window(() => rmSync(join(root, "a.ts")));

    expect(result).toMatchObject({
      status: "AVAILABLE",
      changes: [{ path: "a.ts", preState: "CLEAN", post: { state: "ABSENT" } }],
    });
  });

  test("a file dirty before the call is DIRTY", () => {
    writeFileSync(join(root, "a.ts"), "dirty\r\n");

    const result = window(() => writeFileSync(join(root, "a.ts"), "dirtier\r\n"));

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "DIRTY",
          post: { state: "PRESENT", digest: sha256Hex("dirtier\r\n") },
        },
      ],
    });
  });

  test("a file rewritten with identical content is not a change", () => {
    const result = window(() => writeFileSync(join(root, "a.ts"), ORIGINAL));

    expect(result).toEqual({ status: "AVAILABLE", changes: [], problems: [] });
  });

  test("a commit during the call is FAILED", () => {
    const result = window(() => {
      writeFileSync(join(root, "a.ts"), "committed\r\n");
      git(root, "commit", "-q", "-am", "inside the window");
    });

    expect(result).toEqual({ status: "FAILED", failure: { kind: "UNPROVEN" } });
  });

  test("an index change during the call is FAILED", () => {
    const result = window(() => {
      writeFileSync(join(root, "a.ts"), "staged\r\n");
      git(root, "add", "a.ts");
    });

    expect(result).toEqual({ status: "FAILED", failure: { kind: "UNPROVEN" } });
  });

  test("a blocked changed path is UNREAD and its content is never read", () => {
    reads.length = 0;

    const result = window(() => writeFileSync(join(root, ".env"), "TOKEN=1\n"));

    expect(result).toEqual({
      status: "AVAILABLE",
      changes: [{ path: ".env", preState: "UNREAD" }],
      problems: [],
    });
    expect(reads.filter((path) => path.endsWith(".env"))).toEqual([]);
  });

  test("a change outside the project root is FAILED", () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "inside.ts"), "x\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "sub");

    const sub = join(root, "sub");
    const scoped: GitShellContext = { ...context, resolveRepoPath: createRepoPathResolver(sub) };
    const pre = takenSnapshot(takeGitSnapshot(scoped, sub));

    writeFileSync(join(root, "a.ts"), "outside\r\n");

    const post = takenSnapshot(takeGitSnapshot(scoped, sub));

    expect(diffGitSnapshots(scoped, pre, post)).toEqual({
      status: "FAILED",
      failure: { kind: "UNPROVEN" },
    });
  });

  test("outside a repository there is no snapshot", () => {
    const loose = join(base, "loose");

    mkdirSync(loose);

    expect(takeGitSnapshot(context, loose)).toEqual({
      status: "FAILED",
      failure: { kind: "UNPROVEN" },
    });
  });
});

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

  test("is captured by default and reviewed against the CRLF index image", () => {
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

  test("a dirty file outside the universe is unavailable", () => {
    world.write("a.ts", "dirty\r\n");
    world.prompt("touch a dirty file");
    shell(() => world.write("a.ts", "dirtier\r\n"));
    world.stop();

    expect(causesOf(world.onlyHandoff())).toEqual(["SHELL_CHANGED_OUTSIDE_UNIVERSE"]);
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

  test("a commit inside the window is unproven", () => {
    world.prompt("commit");
    shell(() => {
      world.write("a.ts", "one\r\nTWO\r\n");
      git(world.projectRoot, "commit", "-q", "-am", "inside");
    });
    world.stop();

    expect(causesOf(world.onlyHandoff())).toContain("SHELL_GIT_DIFF_UNAVAILABLE");
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
    expect(gitCalls).not.toContain("hash-object");
    expect(JSON.stringify(handoff)).not.toContain(SECRET_CONTENT);
    expect(JSON.stringify(world.hookLog())).not.toContain(SECRET_CONTENT);
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
