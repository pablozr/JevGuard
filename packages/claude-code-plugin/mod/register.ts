import {
  agentDeliveryText,
  armWatch,
  baselineWatch,
  chunkText,
  decideDelivery,
  emptyWatch,
  type FeedEnvironment,
  type FeedWatch,
  POLL_INTERVAL_MS,
  PROPOSAL_LOG_CHUNK,
  PROPOSAL_MAX_TOKENS,
  PROPOSAL_TIMEOUT_MS,
  type ProposalDelivery,
  type ProposalFailureCode,
  type ProposalRequestFile,
  type ProposalView,
  parseProposalRequestFile,
  parseReviewFeed,
  proposalFailedToast,
  proposalFailureLine,
  proposalLimitLine,
  proposalReadyToast,
  proposalRequestFileOf,
  proposalSentLine,
  type ReviewFeedLine,
  reviewFeedFileOf,
  tickWatch,
  toProposalView,
  unitLabelOf,
} from "@jevguard/claude-code-adapter/presentation";
import type { EngineInterface, On } from "claude-code";
import type {
  FeedCache,
  FeedTarget,
  Poller,
  ProposalCompletion,
  ProposalTask,
  TakenRequest,
} from "./types";

const TOAST_TIMEOUT_MS = 8000;
const PROPOSAL_STATE = { plugin: "jevguard", key: "proposal" } as const;
const PROPOSAL_TITLE = "JevGuard proposal";
const PANE_ID = "jevguard-proposal";
const DELIVERIES_STATE = { plugin: "jevguard", key: "agentDeliveries" } as const;
const MAX_TRACKED_SESSIONS = 32;
const UNREADABLE: TakenRequest = { status: "FAILED", code: "REQUEST_UNREADABLE" };

let watch: FeedWatch = emptyWatch();
let poller: Poller | undefined;
let target: FeedTarget | undefined;
let polling = false;
let generation = 0;
let cache: FeedCache | undefined;
let queue: ProposalTask[] = [];
let handled = new Set<string>();
let proposing = false;
let lastMainModel: string | undefined;

async function dataEnvironment($: EngineInterface): Promise<FeedEnvironment> {
  return {
    xdgDataHome: await $.env.get("XDG_DATA_HOME"),
    userProfile: await $.env.get("USERPROFILE"),
    home: await $.env.get("HOME"),
  };
}

async function feedTarget($: EngineInterface): Promise<FeedTarget | undefined> {
  const sessionId = await $.session.id();
  const file = reviewFeedFileOf(await dataEnvironment($), sessionId);

  return file === null ? undefined : { file, sessionId };
}

async function readFeed($: EngineInterface, file: string): Promise<readonly ReviewFeedLine[]> {
  const previous = cache?.file === file ? cache : undefined;

  try {
    const text = await $.fs.read(file);

    if (typeof text !== "string") return previous?.lines ?? [];
    if (previous?.text === text) return previous.lines;

    const lines = parseReviewFeed(text);

    cache = { file, text, lines };

    return lines;
  } catch {
    return previous?.lines ?? [];
  }
}

function stopPolling(): void {
  generation += 1;
  poller?.cancel();
  poller = undefined;
}

async function reportFailure(
  $: EngineInterface,
  turnId: string,
  code: ProposalFailureCode,
): Promise<void> {
  await $.ui.toast(proposalFailedToast(), { timeoutMs: TOAST_TIMEOUT_MS });
  await $.ui.log(proposalFailureLine(unitLabelOf(turnId), code));
}

async function takeRequest($: EngineInterface, task: ProposalTask): Promise<TakenRequest> {
  const path = proposalRequestFileOf(await dataEnvironment($), task.target.sessionId, task.turnId);

  if (path === null) return UNREADABLE;

  let text: unknown;

  try {
    text = await $.fs.read(path);
  } catch {
    return UNREADABLE;
  }

  if (typeof text !== "string") return UNREADABLE;
  if (text === "") return { status: "BLANK" };

  try {
    await $.fs.write(path, "");
  } catch {
    return UNREADABLE;
  }

  const file = parseProposalRequestFile(text, { turnId: task.turnId }, await $.clock.now());

  return file === null
    ? { status: "FAILED", code: "REQUEST_INVALID" }
    : { status: "REQUEST", file };
}

function failureOf(reason: "api-error" | "empty-reply" | "aborted"): ProposalFailureCode {
  switch (reason) {
    case "api-error":
      return "MODEL_API_ERROR";
    case "empty-reply":
      return "MODEL_EMPTY_REPLY";
    case "aborted":
      return "MODEL_ABORTED";
  }
}

async function completeProposal(
  $: EngineInterface,
  file: ProposalRequestFile,
): Promise<ProposalCompletion> {
  try {
    const model = file.model ?? lastMainModel ?? (await $.session.model());
    const result = await $.model.complete({
      model,
      system: file.system,
      prompt: file.prompt,
      maxTokens: PROPOSAL_MAX_TOKENS,
      timeoutMs: PROPOSAL_TIMEOUT_MS,
    });

    if (result.isAnswered) return { status: "TEXT", text: result.text };

    return { status: "FAILED", code: failureOf(result.reason) };
  } catch {
    return { status: "FAILED", code: "MODEL_REFUSED" };
  }
}

async function deliveriesIn($: EngineInterface, sessionId: string): Promise<number> {
  const { value } = await $.state.get(DELIVERIES_STATE);

  return value?.[sessionId] ?? 0;
}

async function countDelivery($: EngineInterface, sessionId: string): Promise<void> {
  const { value } = await $.state.get(DELIVERIES_STATE);
  const { [sessionId]: current = 0, ...others } = value ?? {};
  const kept = Object.entries(others).slice(-(MAX_TRACKED_SESSIONS - 1));

  await $.state.set(DELIVERIES_STATE, Object.fromEntries([...kept, [sessionId, current + 1]]));
}

async function announce($: EngineInterface, view: ProposalView): Promise<boolean> {
  await $.state.set(PROPOSAL_STATE, view);

  const opened = await $.ui.open({ id: PANE_ID, title: PROPOSAL_TITLE });

  await $.ui.toast(proposalReadyToast(view.unit), { timeoutMs: TOAST_TIMEOUT_MS });

  return opened.isPlaced;
}

async function showToUser($: EngineInterface, view: ProposalView): Promise<void> {
  if (await announce($, view)) return;

  for (const chunk of chunkText(view.text, PROPOSAL_LOG_CHUNK)) await $.ui.log(chunk);
}

async function sendToAgent(
  $: EngineInterface,
  view: ProposalView,
  sessionId: string,
): Promise<void> {
  await countDelivery($, sessionId);

  try {
    await $.prompt.submit({ text: agentDeliveryText(view) });
  } catch {
    await reportFailure($, view.turnId, "DELIVERY_FAILED");
    await showToUser($, { ...view, delivery: "user" });

    return;
  }

  await $.ui.log(proposalSentLine(view.unit));
  await announce($, view);
}

async function deliver(
  $: EngineInterface,
  task: ProposalTask,
  text: string,
  requested: ProposalDelivery,
): Promise<void> {
  const sessionId = await $.session.id();
  const decided = decideDelivery(requested, await deliveriesIn($, sessionId));
  const effective = decided === "agent" && task.target.sessionId === sessionId ? "agent" : "user";
  const view = toProposalView(task.turnId, text, effective);

  if (requested === "agent" && decided === "user") await $.ui.log(proposalLimitLine(view.unit));

  if (effective === "agent") await sendToAgent($, view, sessionId);
  else await showToUser($, view);
}

async function runProposal($: EngineInterface, task: ProposalTask): Promise<void> {
  const taken = await takeRequest($, task);

  if (taken.status === "BLANK") return;
  if (taken.status === "FAILED") return reportFailure($, task.turnId, taken.code);

  const completion = await completeProposal($, taken.file);

  if (completion.status === "FAILED") return reportFailure($, task.turnId, completion.code);

  await deliver($, task, completion.text, taken.file.delivery);
}

async function drainProposals($: EngineInterface): Promise<void> {
  if (proposing) return;

  proposing = true;

  try {
    for (let task = queue.shift(); task !== undefined; task = queue.shift()) {
      try {
        await runProposal($, task);
      } catch {}
    }
  } finally {
    proposing = false;
  }
}

function queueProposals($: EngineInterface, turnIds: readonly string[], current: FeedTarget): void {
  const fresh = turnIds.filter((turnId) => !handled.has(turnId));

  if (fresh.length === 0) return;

  for (const turnId of fresh) {
    handled.add(turnId);
    queue.push({ turnId, target: current });
  }

  $.clock.after(0, () => {
    void drainProposals($);
  });
}

async function showTick($: EngineInterface, current: FeedTarget, owner: number): Promise<void> {
  const lines = await readFeed($, current.file);
  const nowMs = await $.clock.now();

  if (owner !== generation) return;

  const tick = tickWatch(watch, lines, current.sessionId, nowMs);

  watch = tick.watch;

  if (tick.stop) stopPolling();

  queueProposals($, tick.proposals, current);

  for (const display of tick.displays) {
    if (display.line !== null) await $.ui.log(display.line);
    if (display.toast !== null) await $.ui.toast(display.toast, { timeoutMs: TOAST_TIMEOUT_MS });
  }

  if (tick.status !== null) await $.ui.status(tick.status);
}

async function pollOnce($: EngineInterface, current: FeedTarget, owner: number): Promise<void> {
  if (polling) return;

  polling = true;

  try {
    await showTick($, current, owner);
  } catch {
  } finally {
    polling = false;
  }
}

function startPolling($: EngineInterface, current: FeedTarget): void {
  stopPolling();

  const owner = generation;

  poller = $.clock.every(POLL_INTERVAL_MS, () => pollOnce($, current, owner));
}

async function baseline($: EngineInterface): Promise<void> {
  stopPolling();

  const current = await feedTarget($);

  target = current;
  watch = emptyWatch();

  if (current === undefined) return;

  const lines = await readFeed($, current.file);

  watch = baselineWatch(lines, current.sessionId, await $.clock.now());

  if (watch.armedAtMs !== null) startPolling($, current);
}

async function arm($: EngineInterface): Promise<void> {
  const current = await feedTarget($);

  if (current === undefined) return;

  if (target?.sessionId !== current.sessionId) {
    stopPolling();
    watch = baselineWatch(await readFeed($, current.file), current.sessionId, await $.clock.now());
  }

  target = current;
  watch = armWatch(watch, await $.clock.now());
  startPolling($, current);
}

async function guarded(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch {
    stopPolling();
  }
}

export function register(on: On): void {
  watch = emptyWatch();
  poller = undefined;
  target = undefined;
  polling = false;
  generation = 0;
  cache = undefined;
  queue = [];
  handled = new Set();
  proposing = false;
  lastMainModel = undefined;

  on("session.start", async ($, e, next) => {
    await guarded(() => baseline($));

    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      lastMainModel = e.usage?.model ?? lastMainModel;

      await guarded(() => arm($));
    }

    return next(e);
  });

  on("ui.render", { component: "Pane", requestId: "jevguard-proposal" }, async ($, e) => {
    const { Box, Text, Markdown, Button } = $.ui.resolve(e);
    const { value: view } = await $.state.get(PROPOSAL_STATE);

    if (view === undefined || view === null) {
      return Text({ dimColor: true, children: "No JevGuard proposal yet." });
    }

    return Box({
      flexDirection: "column",
      children: [
        Text({
          bold: true,
          children: `JevGuard proposal · ${view.unit} · strategy only, nothing was applied`,
        }),
        Markdown({ key: "proposal", text: view.text }),
        Button({
          key: "copy",
          label: "Copy apply instruction",
          onPress: async (press) => {
            const copied = await $.ui.copy({ text: view.applyInstruction, surface: press.surface });
            const message = copied.isCopied
              ? "JevGuard: apply instruction copied"
              : "JevGuard: copy unavailable";

            await $.ui.toast(message);
          },
        }),
        Button({
          key: "close",
          label: "Close",
          role: "dismiss",
          onPress: () => $.ui.close({ id: PANE_ID }),
        }),
      ],
    });
  });
}
