import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UNLIMITED_BUDGET } from "../src/capture/budget";
import { createRepoPathResolver, sha256Hex } from "../src/capture/file-image";
import { diffGitSnapshots, takeGitSnapshot } from "../src/capture/git-shell";
import { createNodeFileReader, runGit } from "../src/capture/node-ports";
import type { GitShellContext } from "../src/capture/types";
import { causesOf, git, HookWorld, initRepository, ORIGINAL } from "./hook-world";

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
    };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function window(act: () => void, projectContext = context) {
    const pre = takeGitSnapshot(projectContext, root);

    act();

    const post = takeGitSnapshot(projectContext, root);

    if (pre === null || post === null) throw new Error("snapshot failed");

    return diffGitSnapshots(projectContext, pre, post);
  }

  test("a modified clean file is CLEAN with the index image byte for byte, CRLF included", () => {
    const changed = "one\r\nTWO\r\n";
    const { diff, problems } = window(() => writeFileSync(join(root, "a.ts"), changed));

    expect(problems).toEqual([]);
    expect(diff).toEqual({
      status: "AVAILABLE",
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
    const { diff } = window(() => writeFileSync(join(root, "new.ts"), "fresh\n"));

    expect(diff).toEqual({
      status: "AVAILABLE",
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
    const { diff } = window(() => rmSync(join(root, "a.ts")));

    expect(diff).toMatchObject({
      status: "AVAILABLE",
      changes: [{ path: "a.ts", preState: "CLEAN", post: { state: "ABSENT" } }],
    });
  });

  test("a file dirty before the call is DIRTY", () => {
    writeFileSync(join(root, "a.ts"), "dirty\r\n");

    const { diff } = window(() => writeFileSync(join(root, "a.ts"), "dirtier\r\n"));

    expect(diff).toEqual({
      status: "AVAILABLE",
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
    const { diff } = window(() => writeFileSync(join(root, "a.ts"), ORIGINAL));

    expect(diff).toEqual({ status: "AVAILABLE", changes: [] });
  });

  test("a commit during the call is FAILED", () => {
    const { diff } = window(() => {
      writeFileSync(join(root, "a.ts"), "committed\r\n");
      git(root, "commit", "-q", "-am", "inside the window");
    });

    expect(diff).toEqual({ status: "FAILED" });
  });

  test("an index change during the call is FAILED", () => {
    const { diff } = window(() => {
      writeFileSync(join(root, "a.ts"), "staged\r\n");
      git(root, "add", "a.ts");
    });

    expect(diff).toEqual({ status: "FAILED" });
  });

  test("a blocked changed path is UNREAD and its content is never read", () => {
    reads.length = 0;

    const { diff } = window(() => writeFileSync(join(root, ".env"), "TOKEN=1\n"));

    expect(diff).toEqual({ status: "AVAILABLE", changes: [{ path: ".env", preState: "UNREAD" }] });
    expect(reads.filter((path) => path.endsWith(".env"))).toEqual([]);
  });

  test("a change outside the project root is FAILED", () => {
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "sub", "inside.ts"), "x\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "sub");

    const sub = join(root, "sub");
    const scoped: GitShellContext = { ...context, resolveRepoPath: createRepoPathResolver(sub) };
    const pre = takeGitSnapshot(scoped, sub);

    writeFileSync(join(root, "a.ts"), "outside\r\n");

    const post = takeGitSnapshot(scoped, sub);

    if (pre === null || post === null) throw new Error("snapshot failed");

    expect(diffGitSnapshots(scoped, pre, post).diff).toEqual({ status: "FAILED" });
  });

  test("outside a repository there is no snapshot", () => {
    const loose = join(base, "loose");

    mkdirSync(loose);

    expect(takeGitSnapshot(context, loose)).toBeNull();
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
