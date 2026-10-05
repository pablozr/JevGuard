import { mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createBudget, UNLIMITED_BUDGET } from "../src/capture/budget";
import { createRepoPathResolver, guardPath } from "../src/capture/file-image";
import { diffGitSnapshots, takeGitSnapshot } from "../src/capture/git-shell";
import type {
  CaptureFileReader,
  ClaudeReviewHandoff,
  GitRunner,
  GitShellContext,
  GitSnapshot,
  UnitState,
} from "../src/capture/types";
import { writeBlob } from "../src/capture/unit-state";
import { createFileHandoffSink } from "../src/hook";
import { MAX_STDIN_BYTES, readLimitedStdin } from "../src/hook/read-stdin";
import { resolveAcquisition, toTurn } from "../src/turn";
import { causesOf, HookWorld, initRepository, SESSION } from "./hook-world";
import { Scenario } from "./scenario";

const SECRET = "SECRET_MARKER_9917";

let world: HookWorld;

beforeEach(() => {
  world = new HookWorld();
});

afterEach(() => {
  world.cleanup();
});

function link(target: string, path: string, type?: "junction" | "file" | "dir"): boolean {
  try {
    symlinkSync(target, path, type);

    return true;
  } catch {
    return false;
  }
}

function editThrough(relative: string): void {
  const id = world.nextToolId();
  const input = { file_path: world.path(relative) };

  world.prompt("edit through a link");
  world.preTool("Write", id, input);
  world.postTool("Write", id, input);
  world.stop();
}

function expectNeverRead(handoff: ClaudeReviewHandoff): void {
  expect(causesOf(handoff)).toContain("BLOCKED_PATH");
  expect(world.byteReads).toEqual([]);
  expect(JSON.stringify(handoff)).not.toContain(SECRET);
}

describe("links never reach denied or outside files", () => {
  test("a committed-style symlink to .env is never read", (context) => {
    world.write(".env", SECRET);
    mkdirSync(world.path("docs"), { recursive: true });

    if (!link(join("..", ".env"), world.path("docs", "setup.md"), "file")) context.skip();

    editThrough("docs/setup.md");

    expectNeverRead(world.onlyHandoff());
  });

  test("a junction to a denied directory inside the root is never read", () => {
    world.write(".ssh/config.json", SECRET);
    mkdirSync(world.path("src"), { recursive: true });

    expect(link(world.path(".ssh"), world.path("src", "cfg"), "junction")).toBe(true);

    editThrough("src/cfg/config.json");

    expectNeverRead(world.onlyHandoff());
  });

  test("a junction to a directory outside the root is never read", () => {
    const outside = join(world.base, "outside");

    mkdirSync(outside, { recursive: true });
    world.write("../outside/config.json", SECRET);
    mkdirSync(world.path("src"), { recursive: true });

    expect(link(outside, world.path("src", "out"), "junction")).toBe(true);

    editThrough("src/out/config.json");

    expectNeverRead(world.onlyHandoff());
  });

  test("a new file under a junction to a denied directory is blocked", () => {
    mkdirSync(world.path(".ssh"), { recursive: true });
    mkdirSync(world.path("src"), { recursive: true });

    expect(link(world.path(".ssh"), world.path("src", "cfg"), "junction")).toBe(true);

    editThrough("src/cfg/new.json");

    expectNeverRead(world.onlyHandoff());
  });
});

function fakeReader(table: {
  readonly stats?: Readonly<Record<string, { isLink?: boolean }>>;
  readonly real?: Readonly<Record<string, string>>;
}): CaptureFileReader {
  const stats = new Map(Object.entries(table.stats ?? {}).map(([k, v]) => [resolve(k), v]));
  const real = new Map(Object.entries(table.real ?? {}).map(([k, v]) => [resolve(k), resolve(v)]));

  return {
    stat: (path) => {
      const entry = stats.get(resolve(path));

      return entry === undefined
        ? null
        : { size: 3, mtimeMs: 1, isFile: true, isLink: entry.isLink === true };
    },
    realPath: (path) => {
      const key = resolve(path);

      return real.get(key) ?? (stats.has(key) ? key : null);
    },
    readBytes: () => {
      throw new Error("content must not be read");
    },
  };
}

describe("guardPath classifies the real path", () => {
  test("a short name expanding into a denied directory is blocked", () => {
    const reader = fakeReader({
      stats: { "/r/DOCKER~1/config.json": {} },
      real: { "/r": "/r", "/r/DOCKER~1/config.json": "/r/.ssh/config.json" },
    });

    expect(guardPath(reader, "/r", "/r/DOCKER~1/config.json")).toEqual({ kind: "BLOCKED" });
  });

  test("a real path outside the root is blocked and an inside one is allowed", () => {
    const reader = fakeReader({
      stats: { "/r/a.ts": {}, "/r/b.ts": {} },
      real: { "/r": "/r", "/r/a.ts": "/elsewhere/a.ts" },
    });

    expect(guardPath(reader, "/r", "/r/a.ts")).toEqual({ kind: "BLOCKED" });
    expect(guardPath(reader, "/r", "/r/b.ts").kind).toBe("OK");
  });

  test("a link is blocked without being resolved", () => {
    const reader = fakeReader({ stats: { "/r/l.ts": { isLink: true } }, real: { "/r": "/r" } });

    expect(guardPath(reader, "/r", "/r/l.ts")).toEqual({ kind: "BLOCKED" });
  });
});

interface ScriptedGit {
  readonly runner: GitRunner;
  readonly calls: { args: readonly string[]; input: string | undefined }[];
}

function scriptedGit(options: {
  readonly status: string;
  readonly stage?: string;
  readonly toplevel?: string;
  readonly cwdToplevel?: string;
}): ScriptedGit {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  const encoder = new TextEncoder();
  const runner: GitRunner = (args, cwd, input) => {
    calls.push({ args, input });

    const command = args.find((arg) => !arg.startsWith("--")) ?? "";
    const reply = (text: string) => ({ ok: true, stdout: encoder.encode(text) });

    switch (command) {
      case "rev-parse":
        if (args.includes("--show-toplevel")) {
          return reply(
            cwd === "/inner" ? (options.cwdToplevel ?? "/r") : (options.toplevel ?? "/r"),
          );
        }

        return reply("headsha");
      case "ls-files":
        return reply(options.stage ?? "");
      case "status":
        return reply(options.status);
      case "hash-object":
        return reply(
          `${(input ?? "")
            .split("\n")
            .filter((line) => line !== "")
            .map((_, index) => `hash${index}`)
            .join("\n")}\n`,
        );
      default:
        return reply("");
    }
  };

  return { runner, calls };
}

function gitContext(
  runner: GitRunner,
  files: CaptureFileReader,
  budget = UNLIMITED_BUDGET,
): GitShellContext {
  return {
    git: runner,
    files,
    projectRoot: "/r",
    resolveRepoPath: createRepoPathResolver("/r"),
    budget,
  };
}

describe("Git snapshot never hashes links or reads past its budgets", () => {
  const files = fakeReader({
    stats: { "/r/ok.ts": {}, "/r/link.md": { isLink: true }, "/r/staged.md": {} },
    real: { "/r": "/r" },
  });

  test("worktree links and index symlinks are blocked and never hashed", () => {
    const script = scriptedGit({
      status: "?? ok.ts\0?? link.md\0 M staged.md\0",
      stage: ["120000 abc 0\tstaged.md", "100644 def 0\tother.ts", ""].join("\0"),
    });
    const snapshot = takeGitSnapshot(gitContext(script.runner, files), "/r");
    const hashed = script.calls.find((call) => call.args.includes("hash-object"));

    expect(snapshot?.entries.map((entry) => [entry.gitPath, entry.kind])).toEqual([
      ["link.md", "BLOCKED"],
      ["ok.ts", "READABLE"],
      ["staged.md", "BLOCKED"],
    ]);
    expect(hashed?.input).toBe(`${resolve("/r", "ok.ts")}\n`);
  });

  test("too many dirty entries is no proof", () => {
    const status = Array.from({ length: 5001 }, (_, index) => `?? f${index}.ts\0`).join("");
    const script = scriptedGit({ status });

    expect(takeGitSnapshot(gitContext(script.runner, files), "/r")).toBeNull();
  });

  test("a spent budget is no proof", () => {
    let now = 0;
    const budget = createBudget(() => now, 10);

    now = 11;

    const script = scriptedGit({ status: "" });

    expect(takeGitSnapshot(gitContext(script.runner, files, budget), "/r")).toBeNull();
    expect(script.calls).toEqual([]);
  });

  test("a cwd in another repository than the project is no proof", () => {
    const script = scriptedGit({ status: "", cwdToplevel: "/r/inner" });

    expect(takeGitSnapshot(gitContext(script.runner, files), "/inner")).toBeNull();
  });

  test("too many index reads make the diff FAILED", () => {
    const names = Array.from({ length: 201 }, (_, index) => `f${index}.ts`);
    const present = fakeReader({
      stats: Object.fromEntries(names.map((name) => [`/r/${name}`, {}])),
      real: { "/r": "/r" },
    });
    const reader: CaptureFileReader = {
      ...present,
      readBytes: () => new TextEncoder().encode("x"),
    };
    const script = scriptedGit({ status: "" });
    const empty: GitSnapshot = { toplevel: "/r", head: "h", indexDigest: "d", entries: [] };
    const full: GitSnapshot = {
      ...empty,
      entries: names.map((name) => ({
        gitPath: name,
        repoPath: name,
        kind: "READABLE" as const,
        state: "PRESENT" as const,
        fingerprint: name,
      })),
    };

    expect(diffGitSnapshots(gitContext(script.runner, reader), empty, full).diff).toEqual({
      status: "FAILED",
    });
  });
});

describe("a nested repository", () => {
  test("Bash run inside it is not proven by the project's Git", () => {
    initRepository(world.projectRoot);

    const inner = world.path("inner");

    initRepository(inner);

    const id = world.nextToolId();
    const input = { command: "write" };

    world.prompt("work in the nested repository");
    world.hook({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: input,
      cwd: inner,
    });
    world.write("inner/a.ts", "changed");
    world.hook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_use_id: id,
      tool_input: input,
      cwd: inner,
    });
    world.stop();

    expect(causesOf(world.onlyHandoff())).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });
});

describe("time allowances", () => {
  function rewrittenLines(prefix: string): string {
    return Array.from({ length: 60_000 }, (_, index) => `${prefix}-${index}\n`).join("");
  }

  test("a fully rewritten large file is UNAVAILABLE quickly and never READY", () => {
    world.write("big.ts", rewrittenLines("old"));
    world.prompt("rewrite everything");
    world.edit("big.ts", rewrittenLines("new"));

    const started = performance.now();

    world.stop();

    const elapsed = performance.now() - started;
    const handoff = world.onlyHandoff();

    expect(elapsed).toBeLessThan(5000);
    expect(causesOf(handoff)).toEqual(["PATCH_BUDGET_EXCEEDED"]);
  }, 20_000);

  test("the patch budget is a typed unavailability and shares one deadline", () => {
    const run = new Scenario()
      .prompt()
      .edit("big.ts", rewrittenLines("old"), rewrittenLines("new"))
      .stop();
    const acquisition = run.acquire();

    expect(resolveAcquisition(acquisition, { patchBudgetMs: 100 })).toEqual({
      status: "UNAVAILABLE",
      reason: "MISSING_ATTRIBUTED_DIFF",
      causes: ["PATCH_BUDGET_EXCEEDED"],
    });
    expect(() => toTurn(run.ready(), { patchBudgetMs: 0 })).toThrow("PATCH_BUDGET_EXCEEDED");
  });

  test("a spent hook allowance leaves the unit UNAVAILABLE with a logged code", () => {
    let clock = 0;

    world.monotonicNow = () => {
      clock += 25_000;

      return clock;
    };
    world.write("src/a.ts", "old\n");
    world.prompt("work");
    world.edit("src/a.ts", "new\n");
    world.stop();

    const handoff = world.onlyHandoff();

    expect(handoff.resolution.status).toBe("UNAVAILABLE");
    expect(causesOf(handoff)).toEqual(["CAPTURE_FAILED"]);
    expect(world.hookLog().map((entry) => entry.code)).toContain("HOOK_BUDGET_EXCEEDED");
  });
});

describe("cleanup failures never taint a unit", () => {
  function busy(): never {
    throw Object.assign(new Error("busy"), { code: "EBUSY" });
  }

  test("a failing removal after closure leaves the next unit clean", () => {
    world.removePath = busy;
    world.write("src/a.ts", "old\n");
    world.prompt("one");
    world.edit("src/a.ts", "new\n");
    world.stop();
    world.prompt("two");
    world.edit("src/a.ts", "newer\n");
    world.stop();

    const [first, second] = world.handoffs();

    expect(first?.resolution.status).toBe("TURN");
    expect(second?.resolution.status).toBe("TURN");
    expect(world.hookLog().map((entry) => entry.code)).toContain("STATE_WRITE_FAILED");
  });

  test("failing SessionStart and SessionEnd cleanups are contained", () => {
    world.removePath = busy;
    world.hook({ hook_event_name: "SessionStart" });
    world.hook({ hook_event_name: "SessionEnd" });
    world.write("src/a.ts", "old\n");
    world.prompt("after");
    world.edit("src/a.ts", "new\n");
    world.stop();

    expect(world.onlyHandoff().resolution.status).toBe("TURN");
  });
});

describe("a reborn session never reuses a unit id", () => {
  test("SessionEnd followed by the same session id yields two handoffs", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("one");
    world.edit("src/a.ts", "new\n");
    world.stop();
    world.hook({ hook_event_name: "SessionEnd" });
    world.prompt("two");
    world.edit("src/a.ts", "newer\n");
    world.stop();

    const [first, second] = world.handoffs();

    expect(world.handoffs()).toHaveLength(2);
    expect(first?.sessionId).toBe(SESSION);
    expect(first?.turnId).not.toBe(second?.turnId);
    expect(first?.epoch).not.toBe(second?.epoch);
  });
});

describe("local state permissions", () => {
  test.skipIf(process.platform === "win32")("state is owner-only", () => {
    world.write("src/a.ts", "old\n");
    world.prompt("work");
    world.edit("src/a.ts", "new\n");

    const unit = world.unitDirectory(0);

    expect(statSync(unit).mode & 0o777).toBe(0o700);
    expect(statSync(join(unit, "events.jsonl")).mode & 0o777).toBe(0o600);

    world.stop();

    const handoff = join(world.handoffDirectory(), readdirSync(world.handoffDirectory())[0] ?? "");

    expect(statSync(handoff).mode & 0o777).toBe(0o600);
  });
});

describe("blobs", () => {
  test("an existing blob with the same digest is not rewritten", () => {
    const blobs = join(world.base, "blobs");
    const unit = { blobsDirectory: blobs } as UnitState;
    const digest = writeBlob(unit, Buffer.from("same"));
    const old = new Date("2020-01-01T00:00:00.000Z");

    utimesSync(join(blobs, digest), old, old);
    writeBlob(unit, Buffer.from("same"));

    expect(statSync(join(blobs, digest)).mtime.getTime()).toBe(old.getTime());
  });
});

describe("handoff without hard links", () => {
  const base: ClaudeReviewHandoff = {
    version: 1,
    turnId: "claude-code:s:0123456789abcdef:0",
    sessionId: "s",
    ordinal: 0,
    epoch: "0123456789abcdef",
    projectRoot: "/p",
    closedAt: "2026-10-05T00:00:00.000Z",
    shellCoverage: [],
    resolution: { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" },
  };

  test.each(["EPERM", "ENOTSUP", "EXDEV"])("%s falls back to an exclusive create", (code) => {
    const sink = createFileHandoffSink(world.handoffDirectory(), () => {
      throw Object.assign(new Error("no links"), { code });
    });

    expect(sink.deliver(base)).toBe("CREATED");
    expect(sink.deliver({ ...base, closedAt: "2030-01-01T00:00:00.000Z" })).toBe("EXISTS");

    const files = readdirSync(world.handoffDirectory());

    expect(files).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(world.handoffDirectory(), files[0] ?? ""), "utf8")),
    ).toEqual(base);
  });

  test("any other link failure is FAILED", () => {
    const sink = createFileHandoffSink(world.handoffDirectory(), () => {
      throw Object.assign(new Error("disk"), { code: "EIO" });
    });

    expect(sink.deliver(base)).toBe("FAILED");
    expect(readdirSync(world.handoffDirectory())).toEqual([]);
  });
});

describe("stdin limit", () => {
  test("a stream over the limit is dropped and one within it is read", async () => {
    expect(
      await readLimitedStdin(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10),
    ).toBeNull();
    expect(await readLimitedStdin(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), 10)).toBe(
      "abcd",
    );
    expect(MAX_STDIN_BYTES).toBe(16 * 1024 * 1024);
  });
});
