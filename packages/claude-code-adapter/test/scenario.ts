import type {
  AcquiredUnit,
  CaptureProblem,
  FileImage,
  GitShellChange,
  GitShellDiff,
  HookEvent,
  PostImage,
  ShellEditDiff,
  ToolCategory,
  UnitAcquisition,
  UnitCapture,
} from "../src/index";
import { acquireUnit, splitQuiescentUnits } from "../src/index";

export const CWD = "/repo";

export function resolveRepoPath(rawPath: string, _cwd: string): string | null {
  return rawPath.startsWith(`${CWD}/`) ? rawPath.slice(CWD.length + 1) : null;
}

export function image(content: string | null): FileImage {
  return content === null
    ? { state: "ABSENT" }
    : { state: "PRESENT", digest: `d:${content}`, content };
}

export function postImage(content: string | null): PostImage {
  return content === null ? { state: "ABSENT" } : { state: "PRESENT", digest: `d:${content}` };
}

class RecordingMap<K, V> extends Map<K, V> {
  constructor(private readonly reads: string[]) {
    super();
  }

  override get(key: K): V | undefined {
    this.reads.push(String(key));
    return super.get(key);
  }
}

export interface ToolOptions {
  readonly agent?: string;
  readonly background?: boolean;
}

export interface EditOptions extends ToolOptions {
  readonly toolName?: string;
}

export interface ShellOptions extends ToolOptions {
  readonly git?: GitShellDiff;
  readonly shellDiff?: ShellEditDiff;
  readonly failed?: boolean;
}

/** Builds an ordered event stream plus the capture a Claude Code unit would have recorded. */
export class Scenario {
  readonly events: HookEvent[] = [];
  readonly reads: string[] = [];
  private readonly preImages = new RecordingMap<string, FileImage>(this.reads);
  private readonly postImages = new Map<string, Map<string, PostImage>>();
  private readonly finalImages = new RecordingMap<string, FileImage>(this.reads);
  private readonly gitDiffs = new Map<string, GitShellDiff>();
  private readonly problems = new Set<CaptureProblem>();
  private readonly current = new Map<string, string | null>();
  private counter = 0;

  private base(agent: string | undefined) {
    return {
      sessionId: "s1",
      cwd: CWD,
      promptId: "p1",
      agentId: agent ?? null,
    };
  }

  private nextId(): string {
    this.counter += 1;
    return `tu${this.counter}`;
  }

  private recordPost(id: string, path: string, content: string | null): void {
    const entries = this.postImages.get(id) ?? new RecordingMap<string, PostImage>(this.reads);

    entries.set(path, postImage(content));
    this.postImages.set(id, entries);
    this.current.set(path, content);
  }

  prompt(text = "do the task", agent?: string): this {
    this.events.push({ ...this.base(agent), name: "UserPromptSubmit", prompt: text });
    return this;
  }

  rawPrompt(prompt: string | null): this {
    this.events.push({ ...this.base(undefined), name: "UserPromptSubmit", prompt });
    return this;
  }

  edit(path: string, before: string | null, after: string | null, options: EditOptions = {}): this {
    const id = this.nextId();
    const tool = {
      toolName: options.toolName ?? "Edit",
      category: "EDIT" as const,
      toolUseId: id,
      filePath: `${CWD}/${path}`,
      runInBackground: false,
    };

    if (!this.preImages.has(path)) {
      this.preImages.set(path, image(before));
      this.current.set(path, before);
    }

    this.events.push({ ...this.base(options.agent), name: "PreToolUse", tool });
    this.recordPost(id, path, after);
    this.events.push({
      ...this.base(options.agent),
      name: "PostToolUse",
      tool,
      shellDiff: { status: "ABSENT" },
    });

    return this;
  }

  editWithoutPath(): this {
    const tool = {
      toolName: "Write",
      category: "EDIT" as const,
      toolUseId: this.nextId(),
      filePath: null,
      runInBackground: false,
    };

    this.events.push({ ...this.base(undefined), name: "PreToolUse", tool });
    return this;
  }

  bash(options: ShellOptions = {}): this {
    return this.shell("BASH", "Bash", options);
  }

  powershell(options: ShellOptions = {}): this {
    return this.shell("POWERSHELL", "PowerShell", options);
  }

  private shell(category: "BASH" | "POWERSHELL", toolName: string, options: ShellOptions): this {
    const id = this.nextId();
    const tool = {
      toolName,
      category,
      toolUseId: id,
      filePath: null,
      runInBackground: options.background ?? false,
    };

    this.events.push({ ...this.base(options.agent), name: "PreToolUse", tool });

    if (options.git !== undefined) {
      this.gitDiffs.set(id, options.git);

      if (options.git.status === "AVAILABLE") {
        for (const change of options.git.changes) {
          if (change.preState === "UNREAD") continue;

          this.current.set(change.path, change.post.state === "PRESENT" ? contentOf(change) : null);
        }
      }
    }

    this.events.push(
      options.failed === true
        ? { ...this.base(options.agent), name: "PostToolUseFailure", tool }
        : {
            ...this.base(options.agent),
            name: "PostToolUse",
            tool,
            shellDiff: options.shellDiff ?? { status: "ABSENT" },
          },
    );

    return this;
  }

  tool(category: ToolCategory, toolName: string, options: ToolOptions = {}): this {
    const tool = {
      toolName,
      category,
      toolUseId: this.nextId(),
      filePath: null,
      runInBackground: false,
    };

    this.events.push({ ...this.base(options.agent), name: "PreToolUse", tool });
    this.events.push({
      ...this.base(options.agent),
      name: "PostToolUse",
      tool,
      shellDiff: { status: "ABSENT" },
    });

    return this;
  }

  push(event: HookEvent): this {
    this.events.push(event);
    return this;
  }

  stop(backgroundTasks: "EMPTY" | "ACTIVE" | "UNKNOWN" = "EMPTY", agent?: string): this {
    this.events.push({
      ...this.base(agent),
      name: "Stop",
      backgroundTasks,
      stopHookActive: false,
    });
    return this;
  }

  stopFailure(): this {
    this.events.push({ ...this.base(undefined), name: "StopFailure" });
    return this;
  }

  problem(problem: CaptureProblem): this {
    this.problems.add(problem);
    return this;
  }

  overrideFinal(path: string, content: string | null): this {
    this.current.set(path, content);
    return this;
  }

  capture(): UnitCapture {
    for (const [path, content] of this.current) {
      this.finalImages.set(path, image(content));
    }

    return {
      preImages: this.preImages,
      postImages: this.postImages,
      finalImages: this.finalImages,
      gitDiffs: this.gitDiffs,
      problems: this.problems,
    };
  }

  acquire(ordinal = 0): UnitAcquisition {
    const { closed } = splitQuiescentUnits(this.events);
    const unit = closed[ordinal];

    if (unit === undefined) throw new Error("unit did not close");

    return acquireUnit({ unit, capture: this.capture(), resolveRepoPath });
  }

  ready(): AcquiredUnit {
    const result = this.acquire();

    if (result.status !== "READY") throw new Error(`expected READY, got ${result.status}`);

    return result.unit;
  }
}

function contentOf(change: GitShellChange): string | null {
  if (change.preState === "UNREAD") return null;

  return change.post.state === "PRESENT" ? change.post.digest.slice(2) : null;
}

export function unreadChange(path: string): GitShellChange {
  return { path, preState: "UNREAD" };
}

export function cleanChange(
  path: string,
  preContent: string | null,
  after: string | null,
): GitShellChange {
  return { path, preState: "CLEAN", preImage: image(preContent), post: postImage(after) };
}

export function dirtyChange(
  path: string,
  preContent: string | null,
  after: string | null,
): GitShellChange {
  return { path, preState: "DIRTY", preImage: image(preContent), post: postImage(after) };
}

export function git(...changes: GitShellChange[]): GitShellDiff {
  return { status: "AVAILABLE", changes };
}

export function reasonsOf(result: UnitAcquisition): readonly string[] {
  return result.status === "UNAVAILABLE" ? result.reasons : [];
}
