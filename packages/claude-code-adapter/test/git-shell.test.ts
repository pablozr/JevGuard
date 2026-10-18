import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UNLIMITED_BUDGET } from "../src/capture/budget";
import {
  createRepoPathResolver,
  MAX_CAPTURED_FILE_BYTES,
  sha256Hex,
} from "../src/capture/file-image";
import { takeGitSnapshot } from "../src/capture/git-shell";
import { diffGitSnapshots } from "../src/capture/git-shell-diff";
import { createNodeFileReader, runGit } from "../src/capture/node-ports";
import { createShellDiffMeter, DEFAULT_SHELL_DIFF_LIMITS } from "../src/capture/shell-diff-limits";
import type { GitShellContext } from "../src/capture/types";
import { git, initRepository, ORIGINAL, takenSnapshot } from "./hook-world";

function currentBranch(root: string): string {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function currentCommit(root: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function present(content: string) {
  return { state: "PRESENT", digest: sha256Hex(content), content } as const;
}

function postOf(content: string) {
  return { state: "PRESENT", digest: sha256Hex(content) } as const;
}

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

  test("a modified clean file is CLEAN with the HEAD image byte for byte, CRLF included", () => {
    const changed = "one\r\nTWO\r\n";
    const result = window(() => writeFileSync(join(root, "a.ts"), changed));

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "CLEAN",
          preImage: present(ORIGINAL),
          post: postOf(changed),
        },
      ],
    });
  });

  test("a new untracked file is CLEAN with an absent pre-image", () => {
    const result = window(() => writeFileSync(join(root, "new.ts"), "fresh\n"));

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "new.ts",
          preState: "CLEAN",
          preImage: { state: "ABSENT" },
          post: postOf("fresh\n"),
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
          preImage: present("dirty\r\n"),
          post: postOf("dirtier\r\n"),
        },
      ],
    });
  });

  test("a file rewritten with identical content is not a change", () => {
    const result = window(() => writeFileSync(join(root, "a.ts"), ORIGINAL));

    expect(result).toEqual({ status: "AVAILABLE", changes: [], problems: [] });
  });

  test("a commit of a file dirty before the call changes no content", () => {
    writeFileSync(join(root, "a.ts"), "dirty\r\n");

    const result = window(() => git(root, "commit", "-q", "-am", "inside the window"));

    expect(result).toEqual({ status: "AVAILABLE", changes: [], problems: [] });
  });

  test("a file written and committed inside the call is CLEAN against the HEAD before the call", () => {
    const result = window(() => {
      writeFileSync(join(root, "a.ts"), "committed\r\n");
      git(root, "commit", "-q", "-am", "inside the window");
    });

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "CLEAN",
          preImage: present(ORIGINAL),
          post: postOf("committed\r\n"),
        },
      ],
    });
  });

  test("staging a file dirty before the call changes no content", () => {
    writeFileSync(join(root, "a.ts"), "dirty\r\n");

    const result = window(() => git(root, "add", "a.ts"));

    expect(result).toEqual({ status: "AVAILABLE", changes: [], problems: [] });
  });

  test("a file staged inside the call is still compared with the HEAD before the call", () => {
    const result = window(() => {
      writeFileSync(join(root, "a.ts"), "staged\r\n");
      git(root, "add", "a.ts");
      writeFileSync(join(root, "a.ts"), "later\r\n");
    });

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "CLEAN",
          preImage: present(ORIGINAL),
          post: postOf("later\r\n"),
        },
      ],
    });
  });

  test("a switch to a branch with other content is CLEAN from the old HEAD to the branch", () => {
    const base = currentBranch(root);

    git(root, "switch", "-q", "-c", "feature");
    writeFileSync(join(root, "a.ts"), "branch\r\n");
    git(root, "commit", "-q", "-am", "feature");
    git(root, "switch", "-q", base);

    const result = window(() => git(root, "switch", "-q", "feature"));

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "CLEAN",
          preImage: present(ORIGINAL),
          post: postOf("branch\r\n"),
        },
      ],
    });
  });

  test("a switch away and back inside one call is no change", () => {
    const base = currentBranch(root);

    git(root, "switch", "-q", "-c", "feature");
    writeFileSync(join(root, "a.ts"), "branch\r\n");
    git(root, "commit", "-q", "-am", "feature");
    git(root, "switch", "-q", base);

    const result = window(() => {
      git(root, "switch", "-q", "feature");
      git(root, "switch", "-q", base);
    });

    expect(result).toEqual({ status: "AVAILABLE", changes: [], problems: [] });
  });

  test("checkout of a file dirty before the call is DIRTY, back to the committed content", () => {
    writeFileSync(join(root, "a.ts"), "dirty\r\n");

    const result = window(() => git(root, "checkout", "-q", "--", "a.ts"));

    expect(result).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "DIRTY",
          preImage: present("dirty\r\n"),
          post: postOf(ORIGINAL),
        },
      ],
    });
  });

  test("an unborn HEAD before the call gives an absent pre-image", () => {
    const fresh = join(base, "fresh");

    mkdirSync(fresh);
    git(fresh, "init", "-q");
    git(fresh, "config", "user.email", "test@example.com");
    git(fresh, "config", "user.name", "Test");

    const scoped: GitShellContext = {
      ...context,
      projectRoot: fresh,
      resolveRepoPath: createRepoPathResolver(fresh),
    };
    const pre = takenSnapshot(takeGitSnapshot(scoped, fresh));

    writeFileSync(join(fresh, "a.ts"), "first\n");
    git(fresh, "add", ".");
    git(fresh, "commit", "-q", "-m", "first");

    const post = takenSnapshot(takeGitSnapshot(scoped, fresh));

    expect(pre.snapshot.head).toBeNull();
    expect(diffGitSnapshots(scoped, pre, post)).toEqual({
      status: "AVAILABLE",
      problems: [],
      changes: [
        {
          path: "a.ts",
          preState: "CLEAN",
          preImage: { state: "ABSENT" },
          post: postOf("first\n"),
        },
      ],
    });
  });

  test("a HEAD move listing more paths than the status limit is a limit", () => {
    const limits = { ...DEFAULT_SHELL_DIFF_LIMITS, maxStatusEntries: 2 };
    const bounded: GitShellContext = { ...context, limits, meter: createShellDiffMeter(limits) };

    const result = window(() => {
      for (const name of ["x.ts", "y.ts", "z.ts"]) writeFileSync(join(root, name), `${name}\n`);

      git(root, "add", ".");
      git(root, "commit", "-q", "-m", "three files");
    }, bounded);

    expect(result).toEqual({
      status: "FAILED",
      failure: { kind: "LIMIT_EXCEEDED", limit: "STATUS_ENTRIES" },
    });
  });

  test("a Pre HEAD that no longer names a commit is no proof, not a created file", () => {
    const preHead = currentCommit(root);
    const branch = currentBranch(root);

    const result = window(() => {
      git(root, "checkout", "-q", "--orphan", "other");
      git(root, "commit", "-q", "--allow-empty", "-m", "other root");
      git(root, "branch", "-q", "-D", branch);
      git(root, "reflog", "expire", "--expire=now", "--all");
      git(root, "gc", "-q", "--prune=now");
    });

    expect(() => git(root, "cat-file", "-e", `${preHead}^{commit}`)).toThrow();
    expect(result).toEqual({ status: "FAILED", failure: { kind: "UNPROVEN" } });
  });

  test("a dirty file over 1 MiB rewritten with its size and mtime restored is not unchanged", () => {
    const path = join(root, "big.ts");
    const size = MAX_CAPTURED_FILE_BYTES + 1;

    writeFileSync(path, "a".repeat(size));

    const { mtime } = statSync(path);

    const result = window(() => {
      writeFileSync(path, "b".repeat(size));
      utimesSync(path, mtime, mtime);
    });

    expect(result).toEqual({ status: "AVAILABLE", changes: [], problems: ["CONTENT_TOO_LARGE"] });
  });

  test("a blocked file added and committed inside the call is never read", () => {
    writeFileSync(join(root, ".env"), "TOKEN=1\n");
    reads.length = 0;

    const result = window(() => {
      git(root, "add", "-f", ".env");
      git(root, "commit", "-q", "-m", "env");
    });

    expect(result).toEqual({ status: "AVAILABLE", changes: [], problems: [] });
    expect(reads.filter((path) => path.endsWith(".env"))).toEqual([]);
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
