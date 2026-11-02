import type { Plugin } from "@opencode/plugin";

/**
 * Fake OpenCode 2.2.x plugin `Context` for tests (plan §4 F9 and §10.7).
 *
 * The session and VCS members are typed against `@opencode/plugin@2.2.2` with
 * `satisfies`: a host signature change breaks the build here. Hooks, transforms, the
 * event stream and the location carry effect-branded types, so the fake records them
 * through the narrower plain shapes the plugin reads. The only cast is the one at the
 * boundary that hands the slice to code expecting a full `Plugin.Context`.
 */

type HostContext = Plugin.Context;
type HostSession = HostContext["session"];

export type ContextMessage = Awaited<ReturnType<HostSession["context"]>>[number];
type SessionInfo = Awaited<ReturnType<HostSession["get"]>>;
type SessionCreateInput = NonNullable<Parameters<HostSession["create"]>[0]>;
export type SessionPromptInput = Parameters<HostSession["prompt"]>[0];
export type SessionSyntheticInput = Parameters<HostSession["synthetic"]>[0];
type VcsDiffInput = Parameters<HostContext["vcs"]["diff"]>[0];
type FileDiff = Awaited<ReturnType<HostContext["vcs"]["diff"]>>["data"][number];
type ModelRef = NonNullable<SessionInfo["model"]>;

/** The execution lifecycle events the plugin subscribes to, in their 2.2.x `data` shape. */
export type ExecutionEvent =
  | { readonly type: "session.execution.started"; readonly data: { readonly sessionID: string } }
  | {
      readonly type: "session.execution.succeeded";
      readonly data: { readonly sessionID: string };
    }
  | {
      readonly type: "session.execution.interrupted";
      readonly data: { readonly sessionID: string; readonly reason: "user" };
    }
  | {
      readonly type: "session.execution.failed";
      readonly data: { readonly sessionID: string; readonly error: { readonly message: string } };
    };

type ExecutionKind = "started" | "succeeded" | "interrupted" | "failed";

export interface RetryInput {
  readonly sessionID: string;
  decision?: unknown;
}

export interface ToolAfterInput {
  readonly tool: string;
  readonly sessionID: string;
  readonly input: unknown;
  readonly status: "completed" | "error";
}

interface EditorItem {
  readonly id: string;
}

/** Fake host editor behind `skill.transform` and `agent.transform`. */
export interface FakeEditor<Item extends EditorItem> {
  list(): readonly Item[];
  get(id: string): Item | undefined;
  add(item: Item): void;
  update(id: string, update: (item: Item) => void): void;
  remove(id: string): void;
}

interface Subscription {
  readonly types: readonly string[] | undefined;
  readonly signal: AbortSignal | undefined;
}

type Registration = { readonly dispose: () => Promise<void> };

/** How `session.synthetic` answers: accept, reject, or stay pending until released. */
export type SyntheticBehavior = "accept" | "reject" | "hold";

const ZERO_TOKENS = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const CHILD_SESSION_PREFIX = "ses_child_";

export interface FakeOpenCodeContextOptions {
  /** Canonical project root the plugin reads from `location.project.canonical`. */
  readonly root?: string;
}

export interface FakeOpenCodeContext {
  /** The slice, cast once to the full host type. */
  readonly context: HostContext;
  readonly calls: {
    readonly context: string[];
    readonly get: string[];
    readonly create: SessionCreateInput[];
    readonly prompt: SessionPromptInput[];
    readonly synthetic: SessionSyntheticInput[];
    readonly interrupt: string[];
    readonly diff: VcsDiffInput[];
  };
  readonly subscriptions: readonly Subscription[];
  readonly disposed: readonly string[];
  /** Messages `session.context` returns for a session (default: none). */
  setMessages(sessionID: string, messages: readonly ContextMessage[]): void;
  /** Parent and model `session.get` returns for a session. */
  setSession(sessionID: string, info: { parentID?: string; model?: ModelRef }): void;
  /** Snapshots `vcs.diff` answers in order; the last one repeats. */
  scriptDiffs(...snapshots: readonly (readonly FileDiff[])[]): void;
  /**
   * What a prompted child session answers. Each prompt then runs the child: its context
   * gains the assistant answer and the stream gets its `started`/`succeeded` pair.
   * `null` leaves the child silent.
   */
  setChildAnswer(answer: string | null): void;
  setSyntheticBehavior(behavior: SyntheticBehavior): void;
  /** Settles every held `session.synthetic` call. */
  releaseSynthetic(): void;
  /** Queues one lifecycle event on every open subscription. */
  emit(event: ExecutionEvent): void;
  fireRetry(input: RetryInput): Promise<void>;
  fireToolAfter(input: ToolAfterInput): Promise<void>;
  /** Runs every registered skill transform on the fake skill editor and returns it. */
  runSkillTransforms(): FakeEditor<SkillItem>;
  /** Runs every registered agent transform on the fake agent editor and returns it. */
  runAgentTransforms(): FakeEditor<AgentItem>;
}

export interface SkillItem extends EditorItem {
  readonly name: string;
  readonly description?: string;
  readonly path: string;
  readonly content: string;
}

export interface AgentItem extends EditorItem {
  readonly [key: string]: unknown;
}

/** One lifecycle event for a session. */
export function executionEvent(kind: ExecutionKind, sessionID: string): ExecutionEvent {
  switch (kind) {
    case "started":
      return { type: "session.execution.started", data: { sessionID } };
    case "succeeded":
      return { type: "session.execution.succeeded", data: { sessionID } };
    case "interrupted":
      return { type: "session.execution.interrupted", data: { sessionID, reason: "user" } };
    case "failed":
      return {
        type: "session.execution.failed",
        data: { sessionID, error: { message: "model call failed" } },
      };
  }
}

export function userMessage(id: string, text: string): ContextMessage {
  return { id, type: "user", text, time: { created: 0 } };
}

export function syntheticMessage(
  id: string,
  text: string,
  metadata?: SessionSyntheticInput["metadata"],
): ContextMessage {
  return {
    id,
    type: "synthetic",
    text,
    time: { created: 0 },
    ...(metadata === undefined ? {} : { metadata }),
  };
}

export function assistantMessage(
  id: string,
  options: { readonly text?: string; readonly completed?: boolean } = {},
): ContextMessage {
  return {
    id,
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: options.text === undefined ? [] : [{ type: "text", text: options.text }],
    time: options.completed === false ? { created: 0 } : { created: 0, completed: 1 },
  };
}

/** The marker the host writes when a session goes idle between queued inputs. */
export function idleMessage(
  id: string,
  outcome: "succeeded" | "failed" | "interrupted" = "succeeded",
): ContextMessage {
  return { id, type: "idle", outcome, time: { created: 0 } };
}

export function fileDiff(file: string, patch: string): FileDiff {
  return { file, patch, additions: 1, deletions: 1, status: "modified" };
}

function createEditor<Item extends EditorItem>(items: Map<string, Item>): FakeEditor<Item> {
  return {
    list: () => [...items.values()],
    get: (id) => items.get(id),
    add: (item) => {
      items.set(item.id, item);
    },
    update: (id, update) => {
      const item = items.get(id);

      if (item !== undefined) update(item);
    },
    remove: (id) => {
      items.delete(id);
    },
  };
}

export function createFakeOpenCodeContext(
  options: FakeOpenCodeContextOptions = {},
): FakeOpenCodeContext {
  const root = options.root ?? "/repo";
  const calls: FakeOpenCodeContext["calls"] = {
    context: [],
    get: [],
    create: [],
    prompt: [],
    synthetic: [],
    interrupt: [],
    diff: [],
  };
  const messages = new Map<string, readonly ContextMessage[]>();
  const sessions = new Map<string, { parentID?: string; model?: ModelRef }>();
  const subscriptions: Subscription[] = [];
  const queues: Array<{ readonly items: ExecutionEvent[]; wake: (() => void) | null }> = [];
  const disposed: string[] = [];
  const retryHooks: Array<(input: RetryInput) => Promise<void> | void> = [];
  const toolHooks: Array<(input: ToolAfterInput) => Promise<void> | void> = [];
  const skillTransforms: Array<(editor: FakeEditor<SkillItem>) => void> = [];
  const agentTransforms: Array<(editor: FakeEditor<AgentItem>) => void> = [];
  const skills = new Map<string, SkillItem>();
  const agents = new Map<string, AgentItem>();
  const heldSynthetic: Array<() => void> = [];
  let diffs: Array<readonly FileDiff[]> = [[]];
  let childAnswer: string | null = null;
  let syntheticBehavior: SyntheticBehavior = "accept";
  let childCount = 0;

  function registration(name: string): Registration {
    return {
      dispose: async () => {
        disposed.push(name);
      },
    };
  }

  function emit(event: ExecutionEvent): void {
    for (const queue of queues) {
      queue.items.push(event);
      queue.wake?.();
      queue.wake = null;
    }
  }

  async function* stream(
    types: readonly string[] | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ExecutionEvent> {
    const queue: (typeof queues)[number] = { items: [], wake: null };
    queues.push(queue);

    try {
      while (signal?.aborted !== true) {
        const next = queue.items.shift();

        if (next !== undefined) {
          if (types === undefined || types.includes(next.type)) yield next;
          continue;
        }

        await new Promise<void>((resolve) => {
          queue.wake = resolve;
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } finally {
      queues.splice(queues.indexOf(queue), 1);
    }
  }

  function sessionInfo(id: string): SessionInfo {
    const info = sessions.get(id) ?? {};

    return {
      id,
      projectID: "project",
      cost: 0,
      tokens: ZERO_TOKENS,
      time: { created: 0, updated: 0 },
      location: { directory: root },
      ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
      ...(info.model === undefined ? {} : { model: info.model }),
    };
  }

  function runChild(sessionID: string, text: string): void {
    if (childAnswer === null) return;

    messages.set(sessionID, [
      userMessage(`${sessionID}_user`, text),
      assistantMessage(`${sessionID}_assistant`, { text: childAnswer }),
    ]);
    emit(executionEvent("started", sessionID));
    emit(executionEvent("succeeded", sessionID));
  }

  const session = {
    async context(input) {
      calls.context.push(input.sessionID);

      return [...(messages.get(input.sessionID) ?? [])];
    },
    async get(input) {
      calls.get.push(input.sessionID);

      return sessionInfo(input.sessionID);
    },
    async create(input = {}) {
      calls.create.push(input);
      childCount += 1;

      const id = `${CHILD_SESSION_PREFIX}${childCount}`;

      sessions.set(id, {
        ...(input.parentID == null ? {} : { parentID: input.parentID }),
        ...(input.model == null ? {} : { model: input.model }),
      });

      return sessionInfo(id);
    },
    async prompt(input) {
      calls.prompt.push(input);
      queueMicrotask(() => runChild(input.sessionID, input.text));

      return {
        id: `${input.sessionID}_prompt_${calls.prompt.length}`,
        sessionID: input.sessionID,
        type: "user",
        time: { created: 0 },
        payload: { text: input.text },
        delivery: "queue",
      };
    },
    async synthetic(input) {
      calls.synthetic.push(input);

      if (syntheticBehavior === "reject") throw new Error("synthetic rejected");

      if (syntheticBehavior === "hold") {
        await new Promise<void>((resolve) => heldSynthetic.push(resolve));
      }

      return {
        id: `${input.sessionID}_synthetic_${calls.synthetic.length}`,
        sessionID: input.sessionID,
        type: "synthetic",
        time: { created: 0 },
        payload: {
          text: input.text,
          ...(input.description == null ? {} : { description: input.description }),
          ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        },
        delivery: input.delivery ?? "steer",
      };
    },
    async interrupt(input) {
      calls.interrupt.push(input.sessionID);

      return { interrupted: true };
    },
  } satisfies Pick<
    HostSession,
    "context" | "get" | "create" | "prompt" | "synthetic" | "interrupt"
  >;

  const vcs = {
    async diff(input) {
      calls.diff.push(input);

      const snapshot = diffs.length > 1 ? diffs.shift() : diffs[0];

      return { location: { directory: root }, data: [...(snapshot ?? [])] };
    },
  } satisfies Pick<HostContext["vcs"], "diff">;

  const slice = {
    location: { directory: root, project: { id: "project", directory: root, canonical: root } },
    session: {
      ...session,
      async hook(name: string, callback: (input: RetryInput) => Promise<void> | void) {
        if (name === "retry") retryHooks.push(callback);

        return registration(`session.${name}`);
      },
    },
    vcs,
    tool: {
      async hook(name: string, callback: (input: ToolAfterInput) => Promise<void> | void) {
        if (name === "execute.after") toolHooks.push(callback);

        return registration(`tool.${name}`);
      },
    },
    skill: {
      async transform(callback: (editor: FakeEditor<SkillItem>) => void) {
        skillTransforms.push(callback);

        return registration("skill.transform");
      },
    },
    agent: {
      async transform(callback: (editor: FakeEditor<AgentItem>) => void) {
        agentTransforms.push(callback);

        return registration("agent.transform");
      },
    },
    event: {
      subscribe(options: { types?: readonly string[]; signal?: AbortSignal } = {}) {
        subscriptions.push({ types: options.types, signal: options.signal });

        return stream(options.types, options.signal);
      },
    },
  } satisfies { readonly [Domain in keyof HostContext]?: unknown };

  return {
    context: slice as unknown as HostContext,
    calls,
    subscriptions,
    disposed,
    setMessages(sessionID, list) {
      messages.set(sessionID, list);
    },
    setSession(sessionID, info) {
      sessions.set(sessionID, info);
    },
    scriptDiffs(...snapshots) {
      diffs = snapshots.length === 0 ? [[]] : [...snapshots];
    },
    setChildAnswer(answer) {
      childAnswer = answer;
    },
    setSyntheticBehavior(behavior) {
      syntheticBehavior = behavior;
    },
    releaseSynthetic() {
      for (const release of heldSynthetic.splice(0)) release();
    },
    emit,
    async fireRetry(input) {
      for (const hook of retryHooks) await hook(input);
    },
    async fireToolAfter(input) {
      for (const hook of toolHooks) await hook(input);
    },
    runSkillTransforms() {
      const editor = createEditor(skills);

      for (const transform of skillTransforms) transform(editor);

      return editor;
    },
    runAgentTransforms() {
      const editor = createEditor(agents);

      for (const transform of agentTransforms) transform(editor);

      return editor;
    },
  };
}
