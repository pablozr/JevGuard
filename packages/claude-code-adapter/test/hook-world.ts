import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFileReader, removeTree, runGit } from "../src/capture/node-ports";
import type {
  GitRunner,
  GitSnapshot,
  RemovePath,
  ShellDiffLimits,
  SnapshotResult,
} from "../src/capture/types";
import { keyOf, sessionDirectoryOf } from "../src/capture/unit-state";
import type { ClaudeReviewHandoff, HookDependencies, WorkerSpawnResult } from "../src/hook";
import { createFileHandoffSink, runHook } from "../src/hook";

export const SESSION = "session-1";
export const ORIGINAL = "one\r\ntwo\r\n";

export function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

export function initRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.autocrlf", "true");
  writeFileSync(join(root, "a.ts"), ORIGINAL);
  writeFileSync(join(root, "keep.ts"), "keep\r\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
}

type Payload = Record<string, unknown>;

/** A throwaway project, plugin-data directory and fake process environment. */
export class HookWorld {
  readonly base = realpathSync.native(mkdtempSync(join(tmpdir(), "jevguard-hook-")));
  readonly projectRoot = join(this.base, "project");
  readonly pluginData = join(this.base, "plugin-data");
  readonly environment = new Map<string, string>();
  readonly reads: string[] = [];
  /** Paths whose content was read, as opposed to merely inspected. */
  readonly byteReads: string[] = [];
  spawns = 0;
  spawnWorker: () => WorkerSpawnResult = () => {
    this.spawns += 1;

    return "STARTED";
  };
  removePath: RemovePath = removeTree;
  gitRunner: GitRunner = runGit;
  shellDiffLimits: ShellDiffLimits | undefined;
  monotonicNow: () => number = () => performance.now();
  clock = new Date("2026-10-05T12:00:00.000Z");
  private toolCounter = 0;

  constructor() {
    mkdirSync(this.projectRoot, { recursive: true });
    this.environment.set("CLAUDE_PLUGIN_DATA", this.pluginData);
    this.environment.set("CLAUDE_PROJECT_DIR", this.projectRoot);
  }

  dependencies(): HookDependencies {
    const files = createNodeFileReader();

    return {
      environment: { get: (name) => this.environment.get(name) },
      files: {
        ...files,
        stat: (path) => {
          this.reads.push(path);
          return files.stat(path);
        },
        readBytes: (path, maxBytes) => {
          this.reads.push(path);
          this.byteReads.push(path);
          return files.readBytes(path, maxBytes);
        },
      },
      git: (args, cwd, options) => this.gitRunner(args, cwd, options),
      ...(this.shellDiffLimits === undefined ? {} : { shellDiffLimits: this.shellDiffLimits }),
      now: () => this.clock,
      monotonicNow: () => this.monotonicNow(),
      removePath: (path) => this.removePath(path),
      createHandoffSink: createFileHandoffSink,
      spawnWorker: () => this.spawnWorker(),
    };
  }

  hook(payload: Payload): void {
    runHook(
      JSON.stringify({ session_id: SESSION, cwd: this.projectRoot, ...payload }),
      this.dependencies(),
    );
  }

  raw(stdin: string): void {
    runHook(stdin, this.dependencies());
  }

  path(...segments: string[]): string {
    return join(this.projectRoot, ...segments);
  }

  write(relative: string, content: string | Uint8Array): string {
    const absolute = this.path(relative);

    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, content);

    return absolute;
  }

  nextToolId(): string {
    this.toolCounter += 1;
    return `tool-${this.toolCounter}`;
  }

  prompt(text: string): void {
    this.hook({ hook_event_name: "UserPromptSubmit", prompt: text });
  }

  preTool(toolName: string, toolUseId: string, toolInput: Payload): void {
    this.hook({
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
    });
  }

  postTool(toolName: string, toolUseId: string, toolInput: Payload, toolResponse?: unknown): void {
    this.hook({
      hook_event_name: "PostToolUse",
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
      ...(toolResponse === undefined ? {} : { tool_response: toolResponse }),
    });
  }

  failTool(toolName: string, toolUseId: string, toolInput: Payload): void {
    this.hook({
      hook_event_name: "PostToolUseFailure",
      tool_name: toolName,
      tool_use_id: toolUseId,
      tool_input: toolInput,
    });
  }

  /** Pre, the write itself, then Post, as the host would run an edit tool. */
  edit(relative: string, content: string | Uint8Array, toolName = "Write"): void {
    const id = this.nextToolId();
    const input = { file_path: this.path(relative) };

    this.preTool(toolName, id, input);
    this.write(relative, content);
    this.postTool(toolName, id, input);
  }

  stop(backgroundTasks: readonly unknown[] = []): void {
    this.hook({
      hook_event_name: "Stop",
      background_tasks: backgroundTasks,
      stop_hook_active: false,
    });
  }

  stopFailure(): void {
    this.hook({ hook_event_name: "StopFailure" });
  }

  stateDirectory(): string {
    return join(this.pluginData, "claude-code");
  }

  unitDirectory(ordinal = 0, sessionId = SESSION): string {
    return join(sessionDirectoryOf(this.stateDirectory(), sessionId), "units", String(ordinal));
  }

  sessionDirectory(sessionId = SESSION): string {
    return sessionDirectoryOf(this.stateDirectory(), sessionId);
  }

  handoffDirectory(): string {
    return join(this.stateDirectory(), "handoff");
  }

  handoffs(): readonly ClaudeReviewHandoff[] {
    if (!existsSync(this.handoffDirectory())) return [];

    return readdirSync(this.handoffDirectory())
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(this.handoffDirectory(), name), "utf8")))
      .sort((left, right) => left.ordinal - right.ordinal);
  }

  onlyHandoff(): ClaudeReviewHandoff {
    const [handoff, ...rest] = this.handoffs();

    if (handoff === undefined || rest.length > 0) throw new Error("expected exactly one handoff");

    return handoff;
  }

  hookLog(): readonly Record<string, unknown>[] {
    const file = join(this.stateDirectory(), "hook-log.jsonl");

    if (!existsSync(file)) return [];

    return readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
  }

  cleanup(): void {
    rmSync(this.base, { recursive: true, force: true });
  }
}

export function takenSnapshot(result: SnapshotResult): GitSnapshot {
  if (result.status !== "TAKEN") throw new Error("snapshot failed");

  return result.snapshot;
}

export function causesOf(handoff: ClaudeReviewHandoff): readonly string[] {
  return handoff.resolution.status === "UNAVAILABLE" ? handoff.resolution.causes : [];
}

export function backdate(path: string, hoursAgo: number, now: Date): void {
  const when = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);

  if (existsSync(path) && readdirSafe(path) !== null) {
    for (const name of readdirSafe(path) ?? []) backdate(join(path, name), hoursAgo, now);
  }

  utimesSync(path, when, when);
}

function readdirSafe(path: string): string[] | null {
  try {
    return readdirSync(path);
  } catch {
    return null;
  }
}

export function sessionKeyOf(sessionId: string): string {
  return keyOf(sessionId);
}
