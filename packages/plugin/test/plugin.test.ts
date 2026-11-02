import {
  type BuiltInReviewResult,
  type BuiltInUnavailableReason,
  createFifoJevPort,
  createRemediationProposalStore,
  DEFAULT_EVIDENCE_POLICY,
  PROPOSER_AGENT_PROMPT,
  type JevBuiltInAnswerResult,
  type JevEvaluationPort,
  type JevEvaluationResult,
  type JevRequest,
  type JevRuleEvaluationResult,
  type JevRuleRequest,
  type PolicyLoader,
  type PolicyLoadResult,
  type RemediationProposalRequest,
  type RemediationProposalStore,
  type ReviewLevelResult,
  type ReviewResult,
  type RuleReviewResult,
  type SemanticVerdict,
  type SkippedReason,
  type TurnReview,
  type UnavailableReason,
} from "@jevguard/core";
import type {
  DeliveryStatus,
  RemediationChainEntry,
  RemediationChainLog,
} from "@jevguard/node-infra";
import {
  createOpenCodeOriginPromptFacade,
  createOpenCodeProposalSessionFacade,
  createOpenCodeSessionFacade,
  createTurnTracker,
  type DeliveryMark,
  InMemoryTurnDeduplicator,
  type FileContent,
  type OpenCodeMessage,
  type OpenCodeSessionFacade,
  type OperationalEvent,
  type OperationalLogSink,
  type PresentationDelivery,
  type ProposalFailureReason,
  type ProposalModel,
  type ProposalSessionFacade,
  type ProposalSessionNavigator,
  type RemediationFailureLogSink,
  type RemediationNotifier,
  type OriginSessionPromptFacade,
  type ReviewPresenter,
  type WorkingFileDiff,
} from "@jevguard/opencode-adapter";
import { fileURLToPath } from "node:url";
import type { Plugin } from "@opencode/plugin";
import { describe, expect, test, vi } from "vitest";
import plugin from "../src/index";
import { createPluginDependencies, startPlugin } from "../src/plugin";
import { createRemediationChains, MAX_ACTIVE_CHAINS } from "../src/remediation/chains";
import { createChildExecutionWatcher } from "../src/remediation/child-executions";
import { type ProposalDependencies, proposeForTurn } from "../src/remediation/propose";
import { createPluginRuntime } from "../src/runtime";
import type { PluginRuntime, PluginRuntimeDependencies } from "../src/types";
import {
  assistantMessage,
  type ContextMessage,
  createFakeOpenCodeContext,
  type FakeOpenCodeContext,
  fileDiff,
  executionEvent as hostEvent,
  idleMessage,
  type RetryInput,
  syntheticMessage,
  userMessage,
} from "./fakes/opencode-context";

const SESSION_ID = "ses_1";
const SECOND_SESSION_ID = "ses_2";
const ASSISTANT_ID = "msg_assistant";
const USER_ID = "msg_user";
const SECOND_ASSISTANT_ID = "msg_assistant_2";
const SECOND_USER_ID = "msg_user_2";
const SCOPE_CREEP_ID = "SCOPE-CREEP";
const COMPLEXITY_ID = "COMPLEXITY";
const BUILT_IN_BATCH_LABEL = "BUILT_IN_BATCH";
const MAX_CONCURRENT_JEV_CALLS = 2;

const PATCH = ["--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");

const ALLOWED_EXCEPTION = "Read-only validation and HTTP mapping are allowed.";
const TASK_SENTINEL = "TASK_SENTINEL_PROPOSAL_71c3";
const DIFF_SENTINEL = "DIFF_SENTINEL_PROPOSAL_71c3";
const DOCS_SENTINEL = "DOCS_SENTINEL_PATCH";
const GLOBAL_SENTINEL = "GLOBAL_SENTINEL_PATCH";

function ruleText(id: string, severity: "error" | "warning", scope: string | null): string {
  const lines = [`## ${id}`, "", `severity: ${severity}`];

  if (scope !== null) {
    lines.push(`scope: ${scope}`);
  }

  lines.push(
    "",
    "### Rule",
    "",
    "Module description.",
    "",
    "### Violation",
    "",
    "The change violates the rule.",
  );

  return lines.join("\n");
}

function missingSeverityRule(id: string): string {
  return [
    `## ${id}`,
    "",
    "### Rule",
    "",
    "Module description.",
    "",
    "### Violation",
    "",
    "The change violates the rule.",
  ].join("\n");
}

const VALID_RULE = ruleText("TEST-1", "error", null);

function scopedRule(severity: "error" | "warning"): string {
  return [
    "## TEST-1",
    "",
    `severity: ${severity}`,
    "scope: src/**",
    "",
    "### Rule",
    "",
    "Module description.",
    "",
    "### Violation",
    "",
    "The change violates the rule.",
    "",
    "### Allowed",
    "",
    ALLOWED_EXCEPTION,
  ].join("\n");
}

function executionEvent(
  kind: "started" | "succeeded" | "interrupted" | "failed",
  sessionID: string = SESSION_ID,
): unknown {
  return { type: `session.execution.${kind}`, data: { sessionID } };
}

/** One complete execution of a session: `started`, then `succeeded`. */
function turnEvents(sessionID: string = SESSION_ID): readonly unknown[] {
  return [executionEvent("started", sessionID), executionEvent("succeeded", sessionID)];
}

function turnRecords(
  assistantID: string = ASSISTANT_ID,
  userID: string = USER_ID,
): readonly OpenCodeMessage[] {
  return [
    { id: userID, type: "user", completed: false, text: "Implement the thing." },
    { id: assistantID, type: "assistant", completed: true },
  ];
}

function patchDiffs(): readonly WorkingFileDiff[] {
  return [{ file: "src/a.ts", patch: PATCH }];
}

function distractorRecords(): readonly OpenCodeMessage[] {
  return [
    { id: "msg_user_prior", type: "user", completed: false, text: "Prior distractor task." },
    { id: "msg_assistant_prior", type: "assistant", completed: true },
    { id: USER_ID, type: "user", completed: false, text: "Add the guard." },
    { id: "msg_synthetic", type: "synthetic", completed: false, text: "Keep it scoped." },
    { id: ASSISTANT_ID, type: "assistant", completed: true },
  ];
}

function mixedDiffs(): readonly WorkingFileDiff[] {
  return [
    { file: "src/a.ts", patch: PATCH },
    { file: "docs/readme.md", patch: DOCS_SENTINEL },
    { file: "outside.txt", patch: GLOBAL_SENTINEL },
  ];
}

/**
 * Session facade fake over the 2.2.x read model. The tracker reads the parent first
 * when an execution starts and the messages first when it finishes, so the working
 * diff answers `startDiffs` (clean by default) at start and `diffs` at the end.
 */
class FakeFacade implements OpenCodeSessionFacade {
  readonly calls: string[] = [];
  readonly forbidden: string[] = [];
  readonly recordsBySession = new Map<string, readonly OpenCodeMessage[]>();
  readonly parents = new Map<string, string>();
  records: readonly OpenCodeMessage[] = turnRecords();
  startDiffs: readonly WorkingFileDiff[] = [];
  diffs: readonly WorkingFileDiff[] = patchDiffs();
  failure: "none" | "messages" | "diff" = "none";
  block = false;
  private phase: "start" | "end" = "start";
  private releaseMessagesGate: (() => void) | null = null;

  async parentSessionID(sessionID: string): Promise<string | null> {
    this.calls.push("parentSessionID");
    this.phase = "start";

    return this.parents.get(sessionID) ?? null;
  }

  async snapshotWorking(): Promise<readonly WorkingFileDiff[]> {
    this.calls.push("snapshotWorking");

    if (this.failure === "diff") {
      throw new Error("diff unavailable");
    }

    return this.phase === "start" ? this.startDiffs : this.diffs;
  }

  async readFiles(paths: readonly string[]): Promise<ReadonlyMap<string, FileContent>> {
    this.calls.push("readFiles");

    return new Map(paths.map((path) => [path, { kind: "MISSING" } as const]));
  }

  async listMessages(sessionID: string): Promise<readonly OpenCodeMessage[]> {
    this.calls.push("listMessages");
    this.phase = "end";

    if (this.block) {
      await new Promise<void>((resolve) => {
        this.releaseMessagesGate = resolve;
      });
    }

    if (this.failure === "messages") {
      throw new Error("messages unavailable");
    }

    return this.recordsBySession.get(sessionID) ?? this.records;
  }

  releaseMessages(): void {
    this.releaseMessagesGate?.();
    this.releaseMessagesGate = null;
  }

  prompt(): void {
    this.forbidden.push("prompt");
  }

  synthetic(): void {
    this.forbidden.push("synthetic");
  }

  updateMessage(): void {
    this.forbidden.push("updateMessage");
  }
}

class FakePolicyLoader implements PolicyLoader {
  readonly calls: string[] = [];
  result: PolicyLoadResult = { status: "LOADED", source: { rules: VALID_RULE, config: null } };
  failure: Error | null = null;

  async load(): Promise<PolicyLoadResult> {
    this.calls.push("load");

    if (this.failure !== null) {
      throw this.failure;
    }

    return this.result;
  }
}

class FakePresenter implements ReviewPresenter {
  readonly reviews: TurnReview[] = [];
  attempts = 0;
  fail = false;

  async present(review: TurnReview): Promise<PresentationDelivery> {
    this.attempts += 1;

    if (this.fail) {
      throw new Error("presentation unavailable");
    }

    this.reviews.push(review);

    return { log: "DELIVERED", toast: "DELIVERED" };
  }
}

class FakeNotifier implements RemediationNotifier {
  readonly calls: string[] = [];
  fail = false;

  constructor(private readonly order: string[] = []) {}

  async proposalPreparing(): Promise<DeliveryStatus> {
    return this.record("proposalPreparing", "prepare");
  }

  async proposalReady(): Promise<DeliveryStatus> {
    return this.record("proposalReady", "notify");
  }

  async proposalFailed(): Promise<DeliveryStatus> {
    return this.record("proposalFailed", "fail");
  }

  private record(call: string, label: string): DeliveryStatus {
    if (this.fail) {
      throw new Error("notifier unavailable");
    }

    this.calls.push(call);
    this.order.push(label);

    return "DELIVERED";
  }
}

class FakeFailureSink implements RemediationFailureLogSink {
  readonly reasons: ProposalFailureReason[] = [];
  fail = false;

  async write(reason: ProposalFailureReason): Promise<DeliveryStatus> {
    if (this.fail) {
      throw new Error("failure log unavailable");
    }

    this.reasons.push(reason);

    return "DELIVERED";
  }
}

class FakeNavigator implements ProposalSessionNavigator {
  readonly calls: string[] = [];
  fail = false;

  constructor(private readonly order: string[] = []) {}

  async navigate(sessionID: string): Promise<DeliveryStatus> {
    if (this.fail) {
      throw new Error("navigation unavailable");
    }

    this.calls.push(sessionID);
    this.order.push("navigate");

    return "DELIVERED";
  }
}

class RecordingProposalStore implements RemediationProposalStore {
  constructor(
    private readonly inner: RemediationProposalStore,
    private readonly order: string[],
  ) {}

  claim(evaluationId: string): boolean {
    return this.inner.claim(evaluationId);
  }

  registerChildSession(sessionID: string): void {
    this.order.push("register");
    this.inner.registerChildSession(sessionID);
  }

  isChildSession(sessionID: string): boolean {
    return this.inner.isChildSession(sessionID);
  }
}

const ORIGIN_MODEL: ProposalModel = { providerID: "anthropic", modelID: "claude-sonnet-5-5" };

interface CreatedChild {
  readonly parentID: string;
  readonly title: string;
  readonly model: ProposalModel;
}

/**
 * Proposal facade fake. A successful prompt makes the host run the child: the fake
 * emits the child's terminal lifecycle event through `emit` (wired to the runtime),
 * or nothing when `childOutcome` is `"none"`, which leaves the proposal to time out.
 */
class FakeProposalFacade implements ProposalSessionFacade {
  readonly created: CreatedChild[] = [];
  readonly prompts: Array<{ readonly sessionID: string; readonly text: string }> = [];
  readonly interrupts: string[] = [];
  nextSessionID = "ses_child";
  originModelValue: ProposalModel | null = ORIGIN_MODEL;
  failOrigin = false;
  failCreate = false;
  failPrompt = false;
  childOutcome: "succeeded" | "failed" | "none" = "succeeded";
  answer: string | null = PROPOSER_ANSWER;
  beforeRead: () => void = () => undefined;
  emit: (event: unknown) => void = () => undefined;

  constructor(private readonly order: string[] = []) {}

  async originModel(): Promise<ProposalModel | null> {
    if (this.failOrigin) {
      throw new Error("origin session unavailable");
    }

    return this.originModelValue;
  }

  async createChildSession(input: CreatedChild): Promise<string> {
    this.created.push({ parentID: input.parentID, title: input.title, model: input.model });
    this.order.push("create");

    if (this.failCreate) {
      throw new Error("child session unavailable");
    }

    return this.nextSessionID;
  }

  async prompt(input: { readonly sessionID: string; readonly text: string }): Promise<void> {
    this.prompts.push(input);
    this.order.push("prompt");

    if (this.failPrompt) {
      throw new Error("proposal prompt unavailable");
    }

    if (this.childOutcome !== "none") {
      this.emit(executionEvent("started", input.sessionID));
      this.emit(executionEvent(this.childOutcome, input.sessionID));
    }
  }

  async readProposal(): Promise<string | null> {
    this.order.push("readProposal");
    this.beforeRead();

    return this.answer;
  }

  async interrupt(sessionID: string): Promise<void> {
    this.interrupts.push(sessionID);
  }
}

const PROPOSER_ANSWER = "Move the check back into the handler.";

class FakeOriginPrompt implements OriginSessionPromptFacade {
  readonly sent: Array<{
    readonly sessionID: string;
    readonly text: string;
    readonly mark: DeliveryMark;
  }> = [];
  fail = false;

  async promptVisible(sessionID: string, text: string, mark: DeliveryMark): Promise<void> {
    if (this.fail) {
      throw new Error("synthetic rejected");
    }

    this.sent.push({ sessionID, text, mark });
  }
}

class FakeChainLog implements RemediationChainLog {
  readonly entries: RemediationChainEntry[] = [];

  async record(entry: RemediationChainEntry): Promise<void> {
    this.entries.push(entry);
  }
}

class FakeOperationalSink implements OperationalLogSink {
  readonly events: OperationalEvent[] = [];

  async write(event: OperationalEvent): Promise<DeliveryStatus> {
    this.events.push(event);

    return "DELIVERED";
  }
}

function requestCallLabel(request: JevRequest): string {
  return request.kind === "RULE" ? request.question.criteria.id : BUILT_IN_BATCH_LABEL;
}

class FakeJev implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];
  readonly activations: string[] = [];
  readonly probabilities = new Map<string, number>();
  readonly failingIds = new Set<string>();
  active = 0;
  maxActive = 0;
  probability = 0.1;
  fail = false;
  block = false;
  private pending: Array<{ label: string; resolve: () => void }> = [];
  private readonly activationWaiters: Array<{ count: number; resolve: () => void }> = [];

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    return this.evaluateRequest(request);
  }

  async evaluateRuleBatch(
    requests: readonly JevRuleRequest[],
  ): Promise<readonly JevRuleEvaluationResult[]> {
    const results: JevRuleEvaluationResult[] = [];

    for (const request of requests) {
      const result = await this.evaluateRequest(request);

      results.push(
        result.kind === "RULE"
          ? result
          : { kind: "RULE", status: "FAILED", reason: "INVALID_RESPONSE" },
      );
    }

    return results;
  }

  private async evaluateRequest(request: JevRequest): Promise<JevEvaluationResult> {
    const label = requestCallLabel(request);

    this.requests.push(request);
    this.activations.push(label);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.notifyActivations();

    if (this.block) {
      await new Promise<void>((resolve) => this.pending.push({ label, resolve }));
    }

    this.active -= 1;

    if (request.kind === "RULE") {
      const id = request.question.criteria.id;

      if (this.fail || this.failingIds.has(id)) {
        return { kind: "RULE", status: "FAILED", reason: "MISSING_CREDENTIAL" };
      }

      return {
        kind: "RULE",
        status: "EVALUATED",
        noul: { violationProbability: this.probabilities.get(id) ?? this.probability },
      };
    }

    if (this.fail) {
      return { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "MISSING_CREDENTIAL" };
    }

    return {
      kind: "BUILT_IN_BATCH",
      status: "EVALUATED",
      answers: {
        scopeCreep: this.answer(SCOPE_CREEP_ID),
        complexity: this.answer(COMPLEXITY_ID),
      },
    };
  }

  async waitForActivations(count: number): Promise<void> {
    if (this.activations.length >= count) {
      return;
    }

    await new Promise<void>((resolve) => this.activationWaiters.push({ count, resolve }));
  }

  release(label?: string): void {
    const remaining: Array<{ label: string; resolve: () => void }> = [];

    for (const entry of this.pending) {
      if (label === undefined || entry.label === label) {
        entry.resolve();
      } else {
        remaining.push(entry);
      }
    }

    this.pending = remaining;
  }

  private answer(id: string): JevBuiltInAnswerResult {
    if (this.failingIds.has(id)) {
      return { status: "FAILED", reason: "MISSING_CREDENTIAL" };
    }

    return {
      status: "EVALUATED",
      noul: { violationProbability: this.probabilities.get(id) ?? this.probability },
    };
  }

  private notifyActivations(): void {
    this.settle(this.activationWaiters, this.activations.length);
  }

  private settle(waiters: Array<{ count: number; resolve: () => void }>, value: number): void {
    const remaining: Array<{ count: number; resolve: () => void }> = [];

    for (const waiter of waiters) {
      if (value >= waiter.count) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }

    waiters.length = 0;
    waiters.push(...remaining);
  }
}

interface Harness {
  readonly runtime: PluginRuntime;
  readonly dependencies: PluginRuntimeDependencies;
  readonly facade: FakeFacade;
  readonly policy: FakePolicyLoader;
  readonly presenter: FakePresenter;
  readonly jev: FakeJev;
  readonly proposals: RemediationProposalStore;
  readonly proposalFacade: FakeProposalFacade;
  readonly navigator: FakeNavigator;
  readonly notifier: FakeNotifier;
  readonly failures: FakeFailureSink;
  readonly operational: FakeOperationalSink;
  readonly origin: FakeOriginPrompt;
  readonly chainLog: FakeChainLog;
  readonly order: string[];
}

const TEST_PROPOSAL_TIMEOUT_MS = 20;

/**
 * Mirrors the composition root with the real turn tracker over the fake session
 * facade: the plugin wraps the concrete Jev port in one shared FIFO concurrency
 * limit, so orchestration tests exercise the real cap.
 */
function harness(options: { readonly remediate?: { readonly maxAttempts: number } } = {}): Harness {
  const facade = new FakeFacade();
  const policy = new FakePolicyLoader();
  const presenter = new FakePresenter();
  const jev = new FakeJev();
  const order: string[] = [];
  const proposals = new RecordingProposalStore(createRemediationProposalStore(), order);
  const proposalFacade = new FakeProposalFacade(order);
  const navigator = new FakeNavigator(order);
  const notifier = new FakeNotifier(order);
  const failures = new FakeFailureSink();
  const operational = new FakeOperationalSink();
  const origin = new FakeOriginPrompt();
  const chainLog = new FakeChainLog();

  const dependencies: PluginRuntimeDependencies = {
    tracker: createTurnTracker({ facade, deduplicator: new InMemoryTurnDeduplicator() }),
    operational,
    remediation:
      options.remediate === undefined
        ? null
        : {
            originPrompt: origin,
            maxAttempts: options.remediate.maxAttempts,
            chains: createRemediationChains(),
            chainLog,
          },
    policy,
    presenter,
    jev: createFifoJevPort(jev, { maxConcurrency: MAX_CONCURRENT_JEV_CALLS }),
    proposals,
    proposalFacade,
    navigator,
    notifier,
    failures,
    childExecutions: createChildExecutionWatcher(),
    proposalTimeoutMs: TEST_PROPOSAL_TIMEOUT_MS,
  };
  const runtime = createPluginRuntime(dependencies);

  proposalFacade.emit = (event) => runtime.onEvent(event);

  return {
    runtime,
    dependencies,
    facade,
    policy,
    presenter,
    jev,
    proposals,
    proposalFacade,
    navigator,
    notifier,
    failures,
    operational,
    origin,
    chainLog,
    order,
  };
}

/** Hands events to the runtime without waiting for the queued or detached work. */
function send(runtime: PluginRuntime, events: unknown): void {
  for (const event of Array.isArray(events) ? events : [events]) {
    runtime.onEvent(event);
  }
}

async function dispatch(runtime: PluginRuntime, events: unknown): Promise<void> {
  send(runtime, events);
  await runtime.drain();
}

function lastReview(presenter: FakePresenter): TurnReview {
  const review = presenter.reviews[presenter.reviews.length - 1];

  if (review === undefined) {
    throw new Error("expected a presented review");
  }

  return review;
}

function lastResults(presenter: FakePresenter): readonly ReviewResult[] {
  return lastReview(presenter).results;
}

function jevCalls(jev: FakeJev): readonly string[] {
  return jev.activations;
}

function jevRequestedChecks(jev: FakeJev): readonly string[] {
  return jev.requests.flatMap((request) =>
    request.kind === "RULE" ? [request.question.criteria.id] : [SCOPE_CREEP_ID, COMPLEXITY_ID],
  );
}

function jevCheckSet(jev: FakeJev): ReadonlySet<string> {
  return new Set(jevRequestedChecks(jev));
}

function batchRequests(jev: FakeJev): readonly JevRequest[] {
  return jev.requests.filter((request) => request.kind === "BUILT_IN_BATCH");
}

function loadRules(policy: FakePolicyLoader, rules: string, config: string | null = null): void {
  policy.result = { status: "LOADED", source: { rules, config } };
}

function wholeSlicePath(scopedPaths: readonly string[]): string | null {
  return scopedPaths.length === 1 ? (scopedPaths[0] ?? null) : null;
}

function ruleEvaluated(
  ruleId: string,
  severity: "error" | "warning",
  outcome: SemanticVerdict,
  probability: number,
  scopedPaths: readonly string[],
): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: ASSISTANT_ID,
    ruleId,
    severity,
    scopedPaths,
    outcome,
    violationProbability: probability,
    evidence: {
      mode: "WHOLE",
      plannedSliceCount: 1,
      evaluatedSliceCount: 1,
      failedSliceCount: 0,
      notEvaluatedSliceCount: 0,
      slices: [{ index: 0, path: wholeSlicePath(scopedPaths), kind: "WHOLE", hunkOrdinal: null }],
      sliceJudgments: [{ index: 0, probability, outcome }],
      failingSliceIndex: null,
      failureReason: null,
    },
  };
}

function ruleSkipped(
  ruleId: string,
  severity: "error" | "warning" | null,
  reason: SkippedReason,
  scopedPaths: readonly string[] = [],
): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: ASSISTANT_ID,
    ruleId,
    severity,
    scopedPaths,
    outcome: "SKIPPED",
    reason,
  };
}

function ruleUnavailable(
  ruleId: string | null,
  severity: "error" | "warning" | null,
  reason: UnavailableReason,
  scopedPaths: readonly string[] = [],
): RuleReviewResult {
  return {
    kind: "RULE",
    turnId: ASSISTANT_ID,
    ruleId,
    severity,
    scopedPaths,
    outcome: "UNAVAILABLE",
    reason,
    ...(reason === "JEV_FAILURE" && scopedPaths.length > 0
      ? {
          evidence: {
            mode: "WHOLE" as const,
            plannedSliceCount: 1,
            evaluatedSliceCount: 0,
            failedSliceCount: 1,
            notEvaluatedSliceCount: 0,
            slices: [
              {
                index: 0,
                path: wholeSlicePath(scopedPaths),
                kind: "WHOLE" as const,
                hunkOrdinal: null,
              },
            ],
            sliceJudgments: [],
            failingSliceIndex: 0,
            failureReason: reason,
          },
        }
      : {}),
  };
}

function builtInEvaluated(
  outcome: SemanticVerdict,
  probability: number,
  scopedPaths: readonly string[],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: SCOPE_CREEP_ID,
    severity: "error",
    scopedPaths,
    outcome,
    violationProbability: probability,
  };
}

function builtInSkipped(): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: SCOPE_CREEP_ID,
    severity: "error",
    scopedPaths: [],
    outcome: "SKIPPED",
    reason: "NO_ATTRIBUTED_PATCH",
  };
}

function builtInUnavailable(
  reason: BuiltInUnavailableReason,
  scopedPaths: readonly string[] = [],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: SCOPE_CREEP_ID,
    severity: "error",
    scopedPaths,
    outcome: "UNAVAILABLE",
    reason,
  };
}

function complexityEvaluated(
  outcome: SemanticVerdict,
  probability: number,
  scopedPaths: readonly string[],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: COMPLEXITY_ID,
    severity: "warning",
    scopedPaths,
    outcome,
    violationProbability: probability,
  };
}

function complexitySkipped(): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: COMPLEXITY_ID,
    severity: "warning",
    scopedPaths: [],
    outcome: "SKIPPED",
    reason: "NO_ATTRIBUTED_PATCH",
  };
}

function complexityUnavailable(
  reason: BuiltInUnavailableReason,
  scopedPaths: readonly string[] = [],
): BuiltInReviewResult {
  return {
    kind: "BUILT_IN",
    turnId: ASSISTANT_ID,
    ruleId: null,
    checkId: COMPLEXITY_ID,
    severity: "warning",
    scopedPaths,
    outcome: "UNAVAILABLE",
    reason,
  };
}

function reviewUnavailable(turnId: string, reason: UnavailableReason): ReviewLevelResult {
  return {
    kind: "REVIEW",
    turnId,
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

function resultIdentity(result: ReviewResult): string {
  switch (result.kind) {
    case "RULE":
      return result.ruleId ?? "RULE";
    case "BUILT_IN":
      return result.checkId;
    case "REVIEW":
      return "REVIEW";
  }
}

const invalidConfigShape = [
  "version: 2",
  "thresholds:",
  "  error:",
  "    warn: 0.1",
  "    fail: 0.5",
  "  warning:",
  "    warn: 0.5",
].join("\n");

describe("JevGuardPlugin composition", () => {
  test("root entrypoint default-exports a typed OpenCode 2.2.x plugin", () => {
    const typed: Plugin.Plugin = plugin;

    expect(typed.id).toBe("jevguard");
    expect(typeof typed.setup).toBe("function");
  });

  test("ignores events that are not an execution lifecycle event in the data shape", async () => {
    const { runtime, facade, policy, presenter, jev, operational } = harness();

    await dispatch(runtime, [
      { type: "session.idle", properties: { sessionID: SESSION_ID } },
      { type: "session.status", properties: { sessionID: SESSION_ID, status: { type: "idle" } } },
      { type: "session.execution.succeeded", properties: { sessionID: SESSION_ID } },
      { type: "message.updated", data: { sessionID: SESSION_ID } },
    ]);

    expect(facade.calls).toEqual([]);
    expect(policy.calls).toEqual([]);
    expect(presenter.attempts).toBe(0);
    expect(jev.requests).toHaveLength(0);
    expect(operational.events).toEqual([]);
  });

  test.each([
    { probability: 0.1, outcome: "PASS" },
    { probability: 0.5, outcome: "WARN" },
    { probability: 0.8, outcome: "FAIL" },
  ] as const)(
    "presents one aggregate with the $outcome rule, scope creep, and complexity for probability $probability",
    async ({ probability, outcome }) => {
      const { runtime, facade, policy, presenter, jev } = harness();
      jev.probability = probability;
      jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
      jev.probabilities.set(COMPLEXITY_ID, 0.1);

      await dispatch(runtime, turnEvents());

      expect(facade.calls).toEqual([
        "parentSessionID",
        "snapshotWorking",
        "readFiles",
        "listMessages",
        "snapshotWorking",
      ]);
      expect(policy.calls).toEqual(["load"]);
      expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
      expect(jevRequestedChecks(jev)).toEqual(["TEST-1", SCOPE_CREEP_ID, COMPLEXITY_ID]);
      expect(presenter.reviews).toHaveLength(1);
      expect(lastResults(presenter)).toEqual([
        ruleEvaluated("TEST-1", "error", outcome, probability, ["src/a.ts"]),
        builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
        complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
      ]);
      expect(lastReview(presenter).summary.verdict).toBe(outcome);
    },
  );

  test("skips every lane with no attributed patch and zero Jev calls", async () => {
    const { runtime, facade, presenter, jev } = harness();
    facade.diffs = [];

    await dispatch(runtime, turnEvents());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      ruleSkipped("TEST-1", "error", "NO_ATTRIBUTED_PATCH"),
      builtInSkipped(),
      complexitySkipped(),
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: null,
      hasUnavailable: false,
      counts: { pass: 0, warn: 0, fail: 0, skipped: 3, unavailable: 0 },
    });
  });

  test("never invokes message mutation or prompt APIs", async () => {
    const { runtime, facade } = harness();

    await dispatch(runtime, turnEvents());

    expect(facade.forbidden).toEqual([]);
  });
});

describe("JevGuardPlugin event returns before background work", () => {
  test("returns from the event while attribution is still blocked, then drains", async () => {
    const { runtime, facade, presenter } = harness();
    facade.block = true;

    send(runtime, turnEvents());

    while (!facade.calls.includes("listMessages")) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(presenter.reviews).toHaveLength(0);

    facade.releaseMessages();
    await runtime.drain();

    expect(presenter.reviews).toHaveLength(1);
    expect(lastResults(presenter)[0]?.outcome).toBe("PASS");
  });

  test("returns from the event while Jev is still blocked, then drains to results", async () => {
    const { runtime, presenter, jev } = harness();
    jev.block = true;

    send(runtime, turnEvents());
    await jev.waitForActivations(2);

    expect(jev.maxActive).toBe(2);
    expect(presenter.reviews).toHaveLength(0);

    jev.release();
    await runtime.drain();

    expect(presenter.reviews).toHaveLength(1);
    expect(lastResults(presenter).map(resultIdentity)).toEqual([
      "TEST-1",
      SCOPE_CREEP_ID,
      COMPLEXITY_ID,
    ]);
  });
});

describe("JevGuardPlugin operational failures", () => {
  test("reports a review-level MISSING_ATTRIBUTED_DIFF when the messages read fails", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    facade.failure = "messages";

    await dispatch(runtime, turnEvents());

    expect(policy.calls).toEqual([]);
    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(SESSION_ID, "MISSING_ATTRIBUTED_DIFF"),
    ]);
  });

  test("reports a review-level MISSING_ATTRIBUTED_DIFF when the diff read fails", async () => {
    const { runtime, facade, presenter, jev } = harness();
    facade.failure = "diff";

    await dispatch(runtime, turnEvents());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(SESSION_ID, "MISSING_ATTRIBUTED_DIFF"),
    ]);
  });

  test("runs the built-in batch when the rules file is absent", async () => {
    const { runtime, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: null, config: null } };

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(jevRequestedChecks(jev)).toEqual([SCOPE_CREEP_ID, COMPLEXITY_ID]);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: true,
      counts: { pass: 2, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
    });
  });

  test("runs the built-in batch when the rules read fails", async () => {
    const { runtime, policy, presenter, jev } = harness();
    policy.result = { status: "FAILED", reason: "RULES_READ_FAILURE" };

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("keeps a parser-level INVALID_RULE as a rule result distinct from a review-level one", async () => {
    const { runtime, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: "not a rule document", config: null } };

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable(null, null, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("runs the built-in batch with the fixed gates when the config YAML is malformed", async () => {
    const { runtime, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: VALID_RULE, config: "a: [unclosed" } };

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "INVALID_CONFIG"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("runs the built-in batch when the config shape does not resolve", async () => {
    const { runtime, policy, presenter, jev } = harness();
    policy.result = { status: "LOADED", source: { rules: VALID_RULE, config: invalidConfigShape } };

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)[0]).toEqual(ruleUnavailable("TEST-1", "error", "INVALID_CONFIG"));
    expect(lastResults(presenter)[1]).toEqual(builtInEvaluated("PASS", 0.1, ["src/a.ts"]));
    expect(lastResults(presenter)[2]).toEqual(complexityEvaluated("PASS", 0.1, ["src/a.ts"]));
  });

  test("runs the built-in batch when the config read fails", async () => {
    const { runtime, policy, presenter, jev } = harness();
    policy.result = { status: "FAILED", reason: "CONFIG_READ_FAILURE" };

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_CONFIG"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("reports the rule and both built-ins as JEV_FAILURE when the port fails", async () => {
    const { runtime, presenter, jev } = harness();
    jev.fail = true;

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "JEV_FAILURE", ["src/a.ts"]),
      builtInUnavailable("JEV_FAILURE", ["src/a.ts"]),
      complexityUnavailable("JEV_FAILURE", ["src/a.ts"]),
    ]);
  });
});

describe("JevGuardPlugin deduplication and containment", () => {
  test("evaluates a repeated execution of the same assistant message only once", async () => {
    const { runtime, presenter, jev } = harness();

    await dispatch(runtime, turnEvents());
    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
    expect(presenter.reviews).toHaveLength(1);
  });

  test("evaluates a duplicated succeeded event only once and stays silent on the duplicate", async () => {
    const { runtime, presenter, jev, operational } = harness();

    await dispatch(runtime, [...turnEvents(), executionEvent("succeeded")]);

    expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
    expect(presenter.reviews).toHaveLength(1);
    expect(operational.events).toEqual([]);
  });

  test("contains a presentation failure without retry or replacement review", async () => {
    const { runtime, presenter, jev } = harness();
    presenter.fail = true;

    await expect(dispatch(runtime, turnEvents())).resolves.toBeUndefined();

    expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
    expect(presenter.attempts).toBe(1);
    expect(presenter.reviews).toEqual([]);
  });

  test("degrades only the rule lane when the loader rejects unexpectedly", async () => {
    const { runtime, policy, presenter, jev } = harness();
    policy.failure = new Error("programming bug");

    await expect(dispatch(runtime, turnEvents())).resolves.toBeUndefined();

    expect(policy.calls).toEqual(["load"]);
    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(presenter.attempts).toBe(1);
    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(ASSISTANT_ID, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
    expect(JSON.stringify(lastReview(presenter))).not.toContain("programming bug");
  });

  test("keeps handling later executions after a contained failure", async () => {
    const { runtime, facade, presenter, jev } = harness();
    facade.failure = "messages";

    await dispatch(runtime, turnEvents());
    expect(jev.requests).toHaveLength(0);
    expect(presenter.reviews).toHaveLength(1);

    facade.failure = "none";
    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
    expect(presenter.reviews).toHaveLength(2);
    expect(lastResults(presenter)[0]?.outcome).toBe("PASS");
  });

  test("keeps a failed review from poisoning a later review", async () => {
    const { runtime, facade, presenter, jev } = harness();
    jev.fail = true;

    await dispatch(runtime, turnEvents());
    expect(lastResults(presenter)[0]?.outcome).toBe("UNAVAILABLE");

    facade.records = turnRecords(SECOND_ASSISTANT_ID, SECOND_USER_ID);
    jev.fail = false;
    await dispatch(runtime, turnEvents());

    expect(presenter.reviews).toHaveLength(2);
    expect(lastResults(presenter)[0]?.outcome).toBe("PASS");
  });
});

describe("JevGuardPlugin concurrency", () => {
  test("caps in-flight Jev calls at two across the rule lane and the built-in batch", async () => {
    const { runtime, policy, presenter, jev } = harness();
    loadRules(
      policy,
      [ruleText("SRC-1", "error", "src/**"), ruleText("SRC-2", "error", "src/**")].join("\n\n"),
    );
    jev.block = true;

    const pendingReview = dispatch(runtime, turnEvents());

    await jev.waitForActivations(2);

    expect(jev.maxActive).toBe(2);
    expect(jevCalls(jev)).toEqual(["SRC-1", BUILT_IN_BATCH_LABEL]);

    jev.release("SRC-1");
    await jev.waitForActivations(3);

    expect(jevCalls(jev)).toEqual(["SRC-1", BUILT_IN_BATCH_LABEL, "SRC-2"]);
    expect(jev.maxActive).toBe(2);

    jev.release(BUILT_IN_BATCH_LABEL);
    jev.release();
    await pendingReview;

    expect(jev.maxActive).toBe(2);
    expect(lastResults(presenter).map(resultIdentity)).toEqual([
      "SRC-1",
      "SRC-2",
      SCOPE_CREEP_ID,
      COMPLEXITY_ID,
    ]);
  });

  test("caps in-flight Jev calls at two across overlapping background turns", async () => {
    const { runtime, facade, presenter, jev } = harness();
    facade.recordsBySession.set(
      SECOND_SESSION_ID,
      turnRecords(SECOND_ASSISTANT_ID, SECOND_USER_ID),
    );
    jev.block = true;

    send(runtime, turnEvents(SESSION_ID));
    send(runtime, turnEvents(SECOND_SESSION_ID));
    await jev.waitForActivations(2);

    expect(jev.maxActive).toBe(2);

    jev.block = false;
    jev.release();
    await runtime.drain();

    expect(presenter.reviews).toHaveLength(2);
    expect(batchRequests(jev)).toHaveLength(2);
  });

  test("keeps a complexity answer failure from suppressing the sibling rule and scope creep", async () => {
    const { runtime, policy, presenter, jev } = harness();
    loadRules(
      policy,
      [ruleText("SRC-1", "error", "src/**"), ruleText("SRC-2", "error", "src/**")].join("\n\n"),
    );
    jev.block = true;
    jev.failingIds.add(COMPLEXITY_ID);

    const pendingReview = dispatch(runtime, turnEvents());

    await jev.waitForActivations(2);

    expect(jevCalls(jev)).toEqual(["SRC-1", BUILT_IN_BATCH_LABEL]);
    expect(jev.maxActive).toBe(2);

    jev.release("SRC-1");
    await jev.waitForActivations(3);

    expect(jevCalls(jev)).toEqual(["SRC-1", BUILT_IN_BATCH_LABEL, "SRC-2"]);

    jev.release();
    await pendingReview;

    expect(jev.maxActive).toBeLessThanOrEqual(2);
    expect(lastResults(presenter)).toEqual([
      ruleEvaluated("SRC-1", "error", "PASS", 0.1, ["src/a.ts"]),
      ruleEvaluated("SRC-2", "error", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityUnavailable("JEV_FAILURE", ["src/a.ts"]),
    ]);
  });
});

describe("JevGuardPlugin multi-rule end-to-end", () => {
  test("calls Jev once per applicable rule plus one batch in deterministic result order", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    const rules = [
      ruleText("SRC-1", "error", "src/**"),
      ruleText("TEST-2", "warning", "tests/**"),
      ruleText("GLOBAL-3", "warning", null),
    ].join("\n\n");
    loadRules(policy, rules);
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "docs/readme.md", patch: DOCS_SENTINEL },
    ];

    await dispatch(runtime, turnEvents());

    expect(presenter.reviews).toHaveLength(1);
    expect(jevCalls(jev)).toEqual(["SRC-1", BUILT_IN_BATCH_LABEL, "GLOBAL-3"]);
    expect(jevCheckSet(jev)).toEqual(new Set(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "GLOBAL-3"]));
    expect(batchRequests(jev)).toHaveLength(1);
    expect(lastResults(presenter).map(resultIdentity)).toEqual([
      "SRC-1",
      "TEST-2",
      "GLOBAL-3",
      SCOPE_CREEP_ID,
      COMPLEXITY_ID,
    ]);
    expect(lastResults(presenter).map((result) => result.outcome)).toEqual([
      "PASS",
      "SKIPPED",
      "PASS",
      "PASS",
      "PASS",
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: false,
      counts: { pass: 4, warn: 0, fail: 0, skipped: 1, unavailable: 0 },
    });
  });

  test("evaluates valid siblings when one rule block is malformed", async () => {
    const { runtime, policy, presenter, jev } = harness();
    const rules = [
      ruleText("GOOD-1", "error", "src/**"),
      missingSeverityRule("BAD-2"),
      ruleText("GOOD-3", "warning", "src/**"),
    ].join("\n\n");
    loadRules(policy, rules);

    await dispatch(runtime, turnEvents());

    expect(jevCheckSet(jev)).toEqual(new Set(["GOOD-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "GOOD-3"]));
    expect(lastResults(presenter)).toEqual([
      ruleEvaluated("GOOD-1", "error", "PASS", 0.1, ["src/a.ts"]),
      ruleUnavailable("BAD-2", null, "INVALID_RULE"),
      ruleEvaluated("GOOD-3", "warning", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
    expect(lastReview(presenter).summary).toEqual({
      verdict: "PASS",
      hasUnavailable: true,
      counts: { pass: 4, warn: 0, fail: 0, skipped: 0, unavailable: 1 },
    });
  });

  test("records duplicate rule IDs as invalid and still runs the batch", async () => {
    const { runtime, policy, presenter, jev } = harness();
    const rules = [ruleText("DUP-1", "error", "src/**"), ruleText("DUP-1", "error", "src/**")].join(
      "\n\n",
    );
    loadRules(policy, rules);

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("DUP-1", null, "INVALID_RULE"),
      ruleUnavailable("DUP-1", null, "INVALID_RULE"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("does not suppress later rules or the batch after a single Jev failure", async () => {
    const { runtime, policy, presenter, jev } = harness();
    const rules = [ruleText("FAIL-1", "error", "src/**"), ruleText("OK-2", "error", "src/**")].join(
      "\n\n",
    );
    loadRules(policy, rules);
    jev.failingIds.add("FAIL-1");

    await dispatch(runtime, turnEvents());

    expect(jevCheckSet(jev)).toEqual(new Set(["FAIL-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "OK-2"]));
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("FAIL-1", "error", "JEV_FAILURE", ["src/a.ts"]),
      ruleEvaluated("OK-2", "error", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("does not suppress scope creep when only complexity fails", async () => {
    const { runtime, policy, presenter, jev } = harness();
    loadRules(policy, ruleText("OK-1", "error", "src/**"));
    jev.failingIds.add(COMPLEXITY_ID);

    await dispatch(runtime, turnEvents());

    expect(jevCheckSet(jev)).toEqual(new Set(["OK-1", SCOPE_CREEP_ID, COMPLEXITY_ID]));
    expect(lastResults(presenter)).toEqual([
      ruleEvaluated("OK-1", "error", "PASS", 0.1, ["src/a.ts"]),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityUnavailable("JEV_FAILURE", ["src/a.ts"]),
    ]);
  });

  test("keeps blocked, oversized, and clean rule evidence independent with built-in results", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    const rules = [
      ruleText("BLOCK-1", "error", "src/**"),
      ruleText("BIG-2", "error", "big/**"),
      ruleText("CLEAN-3", "warning", "clean/**"),
    ].join("\n\n");
    loadRules(policy, rules);
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "src/.env", patch: "SECRET=1" },
      { file: "big/data.ts", patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1) },
      { file: "clean/a.ts", patch: PATCH },
    ];

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual(["CLEAN-3"]);
    expect(lastResults(presenter).map((result) => result.outcome)).toEqual([
      "UNAVAILABLE",
      "UNAVAILABLE",
      "PASS",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
    expect(lastResults(presenter)[0]).toMatchObject({
      ruleId: "BLOCK-1",
      outcome: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
    expect(lastResults(presenter)[1]).toMatchObject({
      ruleId: "BIG-2",
      outcome: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
    expect(lastResults(presenter)[3]).toEqual(builtInUnavailable("OVERSIZED_DIFF"));
    expect(lastResults(presenter)[4]).toEqual(complexityUnavailable("OVERSIZED_DIFF"));
  });

  test("reports the invalid config once per rule and still runs the batch", async () => {
    const { runtime, policy, presenter, jev } = harness();
    const rules = [ruleText("A-1", "error", "src/**"), ruleText("B-2", "warning", null)].join(
      "\n\n",
    );
    loadRules(policy, rules, invalidConfigShape);

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("A-1", "error", "INVALID_CONFIG"),
      ruleUnavailable("B-2", "warning", "INVALID_CONFIG"),
      builtInEvaluated("PASS", 0.1, ["src/a.ts"]),
      complexityEvaluated("PASS", 0.1, ["src/a.ts"]),
    ]);
  });

  test("deduplicates repeated idles to one aggregate", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    const rules = [
      ruleText("SRC-1", "error", "src/**"),
      ruleText("GLOBAL-2", "warning", null),
    ].join("\n\n");
    loadRules(policy, rules);
    facade.diffs = [{ file: "src/a.ts", patch: PATCH }];

    await dispatch(runtime, turnEvents());
    await dispatch(runtime, turnEvents());

    expect(jevCheckSet(jev)).toEqual(new Set(["SRC-1", SCOPE_CREEP_ID, COMPLEXITY_ID, "GLOBAL-2"]));
    expect(presenter.reviews).toHaveLength(1);
  });
});

describe("JevGuardPlugin gate propagation", () => {
  test.each([
    { severity: "error", probability: 0.399, outcome: "PASS" },
    { severity: "error", probability: 0.4, outcome: "WARN" },
    { severity: "error", probability: 0.699, outcome: "WARN" },
    { severity: "error", probability: 0.7, outcome: "FAIL" },
    { severity: "warning", probability: 0.599, outcome: "PASS" },
    { severity: "warning", probability: 0.6, outcome: "WARN" },
    { severity: "warning", probability: 1, outcome: "WARN" },
  ] as const)(
    "propagates $severity probability $probability as $outcome into the aggregate",
    async ({ severity, probability, outcome }) => {
      const { runtime, policy, presenter, jev } = harness();
      loadRules(policy, scopedRule(severity));
      jev.probability = probability;
      jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
      jev.probabilities.set(COMPLEXITY_ID, 0.1);

      await dispatch(runtime, turnEvents());

      expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
      expect(lastResults(presenter)[0]).toEqual(
        ruleEvaluated("TEST-1", severity, outcome, probability, ["src/a.ts"]),
      );
      expect(lastReview(presenter).summary.verdict).toBe(outcome);
    },
  );
});

describe("JevGuardPlugin runtime short-circuits", () => {
  test("skips an out-of-scope rule while still evaluating the batch", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [{ file: "docs/readme.md", patch: DOCS_SENTINEL }];

    await dispatch(runtime, turnEvents());

    expect(jevCalls(jev)).toEqual([BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)).toEqual([
      ruleSkipped("TEST-1", "error", "NO_SCOPE_MATCH"),
      builtInEvaluated("PASS", 0.1, ["docs/readme.md"]),
      complexityEvaluated("PASS", 0.1, ["docs/readme.md"]),
    ]);
  });

  test("reports an oversized patch as UNAVAILABLE in every lane without a Jev call", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1) },
    ];

    await dispatch(runtime, turnEvents());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "OVERSIZED_DIFF"),
      builtInUnavailable("OVERSIZED_DIFF"),
      complexityUnavailable("OVERSIZED_DIFF"),
    ]);
  });

  test("reports a blocked file as UNAVAILABLE in every lane without a Jev call", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "src/.env", patch: "SECRET=1" },
    ];

    await dispatch(runtime, turnEvents());

    expect(jev.requests).toHaveLength(0);
    expect(lastResults(presenter)).toEqual([
      ruleUnavailable("TEST-1", "error", "BLOCKED_EVIDENCE"),
      builtInUnavailable("BLOCKED_EVIDENCE"),
      complexityUnavailable("BLOCKED_EVIDENCE"),
    ]);
  });
});

describe("JevGuardPlugin observe-only containment", () => {
  test("resolves the FAIL flow without mutating agent messages", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    facade.records = distractorRecords();
    facade.diffs = mixedDiffs();
    jev.probability = 0.8;
    jev.probabilities.set(SCOPE_CREEP_ID, 0.9);

    await expect(dispatch(runtime, turnEvents())).resolves.toBeUndefined();

    expect(lastResults(presenter)[0]).toMatchObject({
      outcome: "FAIL",
      violationProbability: 0.8,
    });
    expect(lastResults(presenter)[1]).toMatchObject({
      kind: "BUILT_IN",
      checkId: SCOPE_CREEP_ID,
      outcome: "FAIL",
    });
    expect(lastResults(presenter)[2]).toMatchObject({
      kind: "BUILT_IN",
      checkId: COMPLEXITY_ID,
      severity: "warning",
      outcome: "WARN",
    });
    expect(lastReview(presenter).summary.verdict).toBe("FAIL");
    expect(facade.forbidden).toEqual([]);
  });

  test("resolves the UNAVAILABLE flow without mutating agent messages", async () => {
    const { runtime, facade, policy, presenter, jev } = harness();
    loadRules(policy, scopedRule("error"));
    jev.fail = true;

    await expect(dispatch(runtime, turnEvents())).resolves.toBeUndefined();

    expect(jevCalls(jev)).toEqual(["TEST-1", BUILT_IN_BATCH_LABEL]);
    expect(lastResults(presenter)[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
    expect(lastResults(presenter)[1]).toMatchObject({
      checkId: SCOPE_CREEP_ID,
      outcome: "UNAVAILABLE",
    });
    expect(lastResults(presenter)[2]).toMatchObject({
      checkId: COMPLEXITY_ID,
      outcome: "UNAVAILABLE",
    });
    expect(facade.forbidden).toEqual([]);
  });
});

const CHILD_SESSION_ID = "ses_child";

const DISABLED_CONFIG = [
  "version: 1",
  "thresholds:",
  "  error:",
  "    warn: 0.4",
  "    fail: 0.7",
  "  warning:",
  "    warn: 0.6",
  "remediation:",
  "  auto_propose: false",
].join("\n");

const CUSTOM_MODEL_CONFIG = [
  "version: 1",
  "thresholds:",
  "  error:",
  "    warn: 0.4",
  "    fail: 0.7",
  "  warning:",
  "    warn: 0.6",
  "remediation:",
  "  model: openai/gpt-5",
].join("\n");

const INVALID_REMEDIATION_CONFIG = [
  "version: 1",
  "thresholds:",
  "  error:",
  "    warn: 0.4",
  "    fail: 0.7",
  "  warning:",
  "    warn: 0.6",
  "remediation:",
  "  model: not-a-provider-model",
].join("\n");

function errorFailSetup(values: Harness): void {
  loadRules(values.policy, scopedRule("error"));
  values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
  values.jev.probability = 0.8;
  values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
  values.jev.probabilities.set(COMPLEXITY_ID, 0.1);
}

function proposalText(values: Harness): string {
  return values.proposalFacade.prompts[0]?.text ?? "";
}

describe("JevGuardPlugin automatic proposals", () => {
  test("creates one deny-all child with the origin model and prompts the proposer contract for a rule FAIL", async () => {
    const values = harness();
    errorFailSetup(values);

    await dispatch(values.runtime, turnEvents());

    expect(lastReview(values.presenter).summary.verdict).toBe("FAIL");
    expect(values.proposalFacade.created).toEqual([
      { parentID: SESSION_ID, title: "JevGuard remediation proposal", model: ORIGIN_MODEL },
    ]);
    expect(values.proposalFacade.prompts).toHaveLength(1);

    const prompt = values.proposalFacade.prompts[0];

    expect(prompt?.sessionID).toBe(CHILD_SESSION_ID);
    expect(prompt?.text.startsWith(`${PROPOSER_AGENT_PROMPT}\n\n`)).toBe(true);
    expect(prompt?.text).toContain("TEST-1");
    expect(prompt?.text).toContain(PATCH);
    expect(values.notifier.calls).toEqual(["proposalPreparing", "proposalReady"]);
    expect(values.navigator.calls).toEqual([CHILD_SESSION_ID]);
  });

  test("creates, registers, navigates, then prompts the child session in order", async () => {
    const values = harness();
    errorFailSetup(values);

    await dispatch(values.runtime, turnEvents());

    expect(values.order).toEqual(["create", "register", "navigate", "prepare", "prompt", "notify"]);
    expect(values.navigator.calls).toEqual([CHILD_SESSION_ID]);
  });

  test("uses the configured model over the origin model for the proposer", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"), CUSTOM_MODEL_CONFIG);
    values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.created[0]?.model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
    });
  });

  test("builds one aggregate request per turn with all FAIL findings and the full attributed patch", async () => {
    const values = harness();
    const rules = [ruleText("SRC-1", "error", "src/**"), ruleText("SRC-2", "error", "src/**")].join(
      "\n\n",
    );
    loadRules(values.policy, rules);
    values.facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "docs/readme.md", patch: DOCS_SENTINEL },
    ];
    values.jev.probabilities.set("SRC-1", 0.8);
    values.jev.probabilities.set("SRC-2", 0.9);
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.95);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.created).toHaveLength(1);
    expect(values.proposalFacade.prompts).toHaveLength(1);

    const text = proposalText(values);

    expect(text).toContain("- id: SRC-1");
    expect(text).toContain("- id: SRC-2");
    expect(text).toContain("- check_id: SCOPE-CREEP");
    expect(text).toContain("severity: error");
    expect(text).toContain("violation_probability: 0.95");
    expect(text).toContain("scoped_paths: src/a.ts");
    expect(text).toContain(DOCS_SENTINEL);
  });

  test("includes a built-in FAIL even without any rule FAIL", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"));
    values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
    values.jev.probability = 0.1;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.95);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.prompts).toHaveLength(1);
    expect(proposalText(values)).toContain("- check_id: SCOPE-CREEP");
  });

  test.each([
    { probability: 0.1, outcome: "PASS" },
    { probability: 0.5, outcome: "WARN" },
  ] as const)(
    "records no proposal for a local error $outcome",
    async ({ probability, outcome }) => {
      const values = harness();
      loadRules(values.policy, scopedRule("error"));
      values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
      values.jev.probability = probability;
      values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
      values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

      await dispatch(values.runtime, turnEvents());

      expect(lastReview(values.presenter).summary.verdict).toBe(outcome);
      expect(values.proposalFacade.created).toEqual([]);
      expect(values.notifier.calls).toEqual([]);
    },
  );

  test("records no proposal for a warning rule", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("warning"));
    values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
    values.jev.probability = 1;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(lastResults(values.presenter)[0]).toMatchObject({ outcome: "WARN" });
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("records no proposal when full turn evidence is blocked despite a scoped rule FAIL", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"));
    values.facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "docs/.env", patch: "SECRET=1" },
    ];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(lastResults(values.presenter)[0]).toMatchObject({
      ruleId: "TEST-1",
      outcome: "FAIL",
    });
    expect(values.proposalFacade.created).toEqual([]);
    expect(values.notifier.calls).toEqual([]);
  });

  test("records no proposal when full turn evidence is oversized despite a scoped rule FAIL", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"));
    values.facade.diffs = [
      { file: "src/a.ts", patch: PATCH },
      { file: "docs/big.ts", patch: "x".repeat(DEFAULT_EVIDENCE_POLICY.maxDiffLength + 1) },
    ];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(lastResults(values.presenter)[0]).toMatchObject({ ruleId: "TEST-1", outcome: "FAIL" });
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("records no proposal when the turn has no attributed patch", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"));
    values.facade.diffs = [];

    await dispatch(values.runtime, turnEvents());

    expect(lastResults(values.presenter)[0]).toMatchObject({ outcome: "SKIPPED" });
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("records no proposal when remediation is disabled by config", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"), DISABLED_CONFIG);
    values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(lastReview(values.presenter).summary.verdict).toBe("FAIL");
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("records no proposal when the config is invalid", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"), invalidConfigShape);
    values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(lastResults(values.presenter)[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "INVALID_CONFIG",
    });
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("treats an invalid remediation section as INVALID_CONFIG", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"), INVALID_REMEDIATION_CONFIG);
    values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents());

    expect(lastResults(values.presenter)[0]).toMatchObject({
      outcome: "UNAVAILABLE",
      reason: "INVALID_CONFIG",
    });
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("records no proposal for a malformed policy", async () => {
    const values = harness();
    loadRules(values.policy, "not a rule document");

    await dispatch(values.runtime, turnEvents());

    expect(lastResults(values.presenter)[0]).toMatchObject({ outcome: "UNAVAILABLE" });
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("creates at most one proposal per evaluated turn across repeated executions", async () => {
    const values = harness();
    errorFailSetup(values);

    await dispatch(values.runtime, turnEvents());
    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.created).toHaveLength(1);
    expect(values.notifier.calls).toEqual(["proposalPreparing", "proposalReady"]);
  });

  test("excludes the registered child session from review", async () => {
    const values = harness();
    errorFailSetup(values);
    values.facade.recordsBySession.set(
      CHILD_SESSION_ID,
      turnRecords(SECOND_ASSISTANT_ID, SECOND_USER_ID),
    );

    await dispatch(values.runtime, turnEvents());

    const callsBefore = values.facade.calls.length;

    await dispatch(values.runtime, turnEvents(CHILD_SESSION_ID));

    expect(values.facade.calls.length).toBe(callsBefore);
    expect(values.presenter.reviews).toHaveLength(1);
    expect(values.proposalFacade.created).toHaveLength(1);
  });

  test("keeps concurrent sessions independent", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"));
    values.facade.recordsBySession.set(
      SECOND_SESSION_ID,
      turnRecords(SECOND_ASSISTANT_ID, SECOND_USER_ID),
    );
    values.facade.diffs = [{ file: "src/a.ts", patch: PATCH }];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);

    await dispatch(values.runtime, turnEvents(SESSION_ID));
    values.proposalFacade.nextSessionID = "ses_child_2";
    await dispatch(values.runtime, turnEvents(SECOND_SESSION_ID));

    expect(values.proposalFacade.created.map((entry) => entry.parentID)).toEqual([
      SESSION_ID,
      SECOND_SESSION_ID,
    ]);
    expect(values.notifier.calls).toEqual([
      "proposalPreparing",
      "proposalReady",
      "proposalPreparing",
      "proposalReady",
    ]);
  });

  test("reports a child session creation failure with one safe failure log and one failure toast", async () => {
    const values = harness();
    errorFailSetup(values);
    values.proposalFacade.failCreate = true;

    await expect(dispatch(values.runtime, turnEvents())).resolves.toBeUndefined();

    expect(lastReview(values.presenter).summary.verdict).toBe("FAIL");
    expect(values.proposalFacade.prompts).toEqual([]);
    expect(values.failures.reasons).toEqual(["CHILD_SESSION_FAILED"]);
    expect(values.notifier.calls).toEqual(["proposalFailed"]);
    expect(values.navigator.calls).toEqual([]);
  });

  test("reports a prompt failure with one safe failure log and no ready toast", async () => {
    const values = harness();
    errorFailSetup(values);
    values.proposalFacade.failPrompt = true;

    await expect(dispatch(values.runtime, turnEvents())).resolves.toBeUndefined();

    expect(lastReview(values.presenter).summary.verdict).toBe("FAIL");
    expect(values.proposalFacade.created).toHaveLength(1);
    expect(values.navigator.calls).toEqual([CHILD_SESSION_ID]);
    expect(values.failures.reasons).toEqual(["PROPOSAL_PROMPT_FAILED"]);
    expect(values.notifier.calls).toEqual(["proposalPreparing", "proposalFailed"]);
  });

  test("reports an invalid model specifier with one safe failure log and one failure toast", async () => {
    const values = harness();
    const request: RemediationProposalRequest = {
      evaluationId: ASSISTANT_ID,
      sessionID: SESSION_ID,
      messageID: ASSISTANT_ID,
      model: "not-a-provider-model",
      task: "Implement the thing.",
      paths: ["src/a.ts"],
      diff: PATCH,
      ruleFindings: [],
      builtInFindings: [],
    };

    await proposeForTurn(request, proposalDependencies(values));

    expect(values.failures.reasons).toEqual(["MODEL_SPECIFIER_INVALID"]);
    expect(values.notifier.calls).toEqual(["proposalFailed"]);
    expect(values.proposalFacade.created).toEqual([]);
  });

  test("contains a notifier failure without changing the review and still prompts", async () => {
    const values = harness();
    errorFailSetup(values);
    values.notifier.fail = true;

    await expect(dispatch(values.runtime, turnEvents())).resolves.toBeUndefined();

    expect(lastReview(values.presenter).summary.verdict).toBe("FAIL");
    expect(values.proposalFacade.prompts).toHaveLength(1);
    expect(values.notifier.calls).toEqual([]);
    expect(values.failures.reasons).toEqual([]);
    expect(values.navigator.calls).toEqual([CHILD_SESSION_ID]);
  });

  test("contains a navigation failure and still prompts the proposal", async () => {
    const values = harness();
    errorFailSetup(values);
    values.navigator.fail = true;

    await expect(dispatch(values.runtime, turnEvents())).resolves.toBeUndefined();

    expect(lastReview(values.presenter).summary.verdict).toBe("FAIL");
    expect(values.proposalFacade.prompts).toHaveLength(1);
    expect(values.notifier.calls).toEqual(["proposalPreparing", "proposalReady"]);
    expect(values.failures.reasons).toEqual([]);
    expect(values.navigator.calls).toEqual([]);
  });

  test("never includes task or diff evidence in the failure log or failure toast", async () => {
    const values = harness();
    loadRules(values.policy, scopedRule("error"));
    values.facade.records = [
      { id: USER_ID, type: "user", completed: false, text: TASK_SENTINEL },
      { id: ASSISTANT_ID, type: "assistant", completed: true },
    ];
    values.facade.diffs = [{ file: "src/a.ts", patch: `${PATCH}${DIFF_SENTINEL}` }];
    values.jev.probability = 0.8;
    values.jev.probabilities.set(SCOPE_CREEP_ID, 0.1);
    values.jev.probabilities.set(COMPLEXITY_ID, 0.1);
    values.proposalFacade.failPrompt = true;

    await dispatch(values.runtime, turnEvents());

    expect(proposalText(values)).toContain(TASK_SENTINEL);
    expect(proposalText(values)).toContain(DIFF_SENTINEL);

    const failureSurface = JSON.stringify({
      reasons: values.failures.reasons,
      toasts: values.notifier.calls,
    });

    expect(failureSurface).not.toContain(TASK_SENTINEL);
    expect(failureSurface).not.toContain(DIFF_SENTINEL);
  });

  test("never invokes parent prompt or message mutation APIs", async () => {
    const values = harness();
    errorFailSetup(values);

    await dispatch(values.runtime, turnEvents());

    expect(values.facade.forbidden).toEqual([]);
  });
});

function proposalDependencies(values: Harness): ProposalDependencies {
  return values.dependencies;
}

describe("JevGuardPlugin proposal lifecycle (2.2.x)", () => {
  test("skips the proposal with a typed log and no child when no model is readable", async () => {
    const values = harness();
    errorFailSetup(values);
    values.proposalFacade.originModelValue = null;

    await dispatch(values.runtime, turnEvents());

    expect(lastReview(values.presenter).summary.verdict).toBe("FAIL");
    expect(values.proposalFacade.created).toEqual([]);
    expect(values.failures.reasons).toEqual(["REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL"]);
    expect(values.notifier.calls).toEqual([]);
  });

  test("treats an origin model read failure as no readable model", async () => {
    const values = harness();
    errorFailSetup(values);
    values.proposalFacade.failOrigin = true;

    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.created).toEqual([]);
    expect(values.failures.reasons).toEqual(["REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL"]);
  });

  test("interrupts a child that outlives the time budget and reports a timeout", async () => {
    const values = harness();
    errorFailSetup(values);
    values.proposalFacade.childOutcome = "none";

    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.prompts).toHaveLength(1);
    expect(values.proposalFacade.interrupts).toEqual([CHILD_SESSION_ID]);
    expect(values.failures.reasons).toEqual(["REMEDIATION_PROPOSAL_TIMEOUT"]);
    expect(values.notifier.calls).toEqual(["proposalPreparing", "proposalFailed"]);
  });

  test("reports a child execution that fails as a prompt failure", async () => {
    const values = harness();
    errorFailSetup(values);
    values.proposalFacade.childOutcome = "failed";

    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.interrupts).toEqual([]);
    expect(values.failures.reasons).toEqual(["PROPOSAL_PROMPT_FAILED"]);
    expect(values.notifier.calls).toEqual(["proposalPreparing", "proposalFailed"]);
  });

  test("never reviews or logs the proposer child's own executions", async () => {
    const values = harness();
    errorFailSetup(values);
    values.proposalFacade.childOutcome = "failed";

    await dispatch(values.runtime, turnEvents());

    expect(values.presenter.reviews).toHaveLength(1);
    expect(values.operational.events).toEqual([]);
  });
});

describe("JevGuardPlugin execution lifecycle (2.2.x)", () => {
  test.each(["interrupted", "failed"] as const)(
    "discards an %s execution without review and logs the skip",
    async (kind) => {
      const { runtime, policy, presenter, jev, operational } = harness();

      await dispatch(runtime, [executionEvent("started"), executionEvent(kind)]);

      expect(policy.calls).toEqual([]);
      expect(jev.requests).toHaveLength(0);
      expect(presenter.attempts).toBe(0);
      expect(operational.events).toEqual([{ kind: "TURN_SKIPPED", reason: kind }]);
    },
  );

  test("presents MISSING_ATTRIBUTED_DIFF and logs MISSING_TURN_START for a succeeded without start", async () => {
    const { runtime, presenter, operational } = harness();

    await dispatch(runtime, executionEvent("succeeded"));

    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(SESSION_ID, "MISSING_ATTRIBUTED_DIFF"),
    ]);
    expect(operational.events).toEqual([
      { kind: "ATTRIBUTION_UNAVAILABLE", reason: "MISSING_TURN_START" },
    ]);
  });

  test("reports BOUNDARY_RACE when the next start arrives before the previous execution is consumed", async () => {
    const { runtime, presenter, operational } = harness();

    await dispatch(runtime, [
      executionEvent("started"),
      executionEvent("succeeded"),
      executionEvent("started"),
    ]);

    expect(lastResults(presenter)).toEqual([
      reviewUnavailable(SESSION_ID, "MISSING_ATTRIBUTED_DIFF"),
    ]);
    expect(operational.events).toEqual([
      { kind: "ATTRIBUTION_UNAVAILABLE", reason: "BOUNDARY_RACE" },
    ]);
  });

  test("reports CONCURRENT_SESSIONS for overlapping top-level executions", async () => {
    const { runtime, facade, presenter, operational, jev } = harness();
    facade.recordsBySession.set(
      SECOND_SESSION_ID,
      turnRecords(SECOND_ASSISTANT_ID, SECOND_USER_ID),
    );

    await dispatch(runtime, [
      executionEvent("started", SESSION_ID),
      executionEvent("started", SECOND_SESSION_ID),
      executionEvent("succeeded", SESSION_ID),
      executionEvent("succeeded", SECOND_SESSION_ID),
    ]);

    expect(jev.requests).toHaveLength(0);
    expect(presenter.reviews).toHaveLength(2);
    expect(operational.events).toEqual([
      { kind: "ATTRIBUTION_UNAVAILABLE", reason: "CONCURRENT_SESSIONS" },
      { kind: "ATTRIBUTION_UNAVAILABLE", reason: "CONCURRENT_SESSIONS" },
    ]);
  });

  test("folds a nested host subagent into its parent execution and stays silent for it", async () => {
    const { runtime, facade, presenter, operational } = harness();
    facade.parents.set("ses_sub", SESSION_ID);

    await dispatch(runtime, [
      executionEvent("started", SESSION_ID),
      executionEvent("started", "ses_sub"),
      executionEvent("interrupted", "ses_sub"),
      executionEvent("succeeded", SESSION_ID),
    ]);

    expect(presenter.reviews).toHaveLength(1);
    expect(lastResults(presenter)[0]?.outcome).toBe("PASS");
    expect(operational.events).toEqual([]);
  });

  test("excludes dirt that predates the execution from the reviewed files", async () => {
    const { runtime, facade, presenter } = harness();
    facade.startDiffs = [{ file: "docs/readme.md", patch: DOCS_SENTINEL }];
    facade.diffs = [
      { file: "docs/readme.md", patch: DOCS_SENTINEL },
      { file: "src/a.ts", patch: PATCH },
    ];

    await dispatch(runtime, turnEvents());

    expect(lastResults(presenter)[0]).toMatchObject({ scopedPaths: ["src/a.ts"] });
  });
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const JEV_INIT_SKILL = fileURLToPath(new URL("../skills/jev-init", import.meta.url));

describe("JevGuardPlugin setup (2.2.x)", () => {
  test("subscribes to the execution lifecycle, reviews from the stream, and cleans up", async () => {
    const values = harness();
    const host = createFakeOpenCodeContext();
    const { runtime, cleanup } = await startPlugin(host.context, values.dependencies, []);

    expect(host.subscriptions[0]?.types).toEqual([
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.interrupted",
      "session.execution.failed",
    ]);

    host.emit(hostEvent("started", SESSION_ID));
    host.emit(hostEvent("succeeded", SESSION_ID));
    await settle();
    await runtime.drain();

    expect(values.presenter.reviews).toHaveLength(1);

    await cleanup();

    expect(host.subscriptions[0]?.signal?.aborted).toBe(true);
    expect([...host.disposed].sort()).toEqual([
      "session.retry",
      "skill.transform",
      "tool.execute.after",
    ]);
  });

  test("disables retry only for registered proposer child sessions", async () => {
    const values = harness();
    const host = createFakeOpenCodeContext();
    const { cleanup } = await startPlugin(host.context, values.dependencies, []);

    values.proposals.registerChildSession(CHILD_SESSION_ID);

    const child: RetryInput = { sessionID: CHILD_SESSION_ID };
    const origin: RetryInput = { sessionID: SESSION_ID };

    await host.fireRetry(child);
    await host.fireRetry(origin);

    expect(child.decision).toEqual({ retry: false });
    expect(origin.decision).toBeUndefined();

    await cleanup();
  });

  test("a write the diff never shows makes the execution INCOMPLETE_FILE_DIFF, whatever its status", async () => {
    const values = harness();
    const host = createFakeOpenCodeContext();
    const { runtime, cleanup } = await startPlugin(host.context, values.dependencies, []);

    host.emit(hostEvent("started", SESSION_ID));
    await settle();
    await host.fireToolAfter({
      tool: "write",
      sessionID: SESSION_ID,
      input: { filePath: "/repo/failed.ts" },
      status: "error",
    });
    host.emit(hostEvent("succeeded", SESSION_ID));
    await settle();
    await runtime.drain();

    expect(lastResults(values.presenter)).toEqual([
      reviewUnavailable(SESSION_ID, "MISSING_ATTRIBUTED_DIFF"),
    ]);
    expect(values.operational.events).toEqual([
      { kind: "ATTRIBUTION_UNAVAILABLE", reason: "INCOMPLETE_FILE_DIFF" },
    ]);

    await cleanup();
  });

  test("registers the bundled skills through the skill transform, idempotently", async () => {
    const values = harness();
    const host = createFakeOpenCodeContext();
    const { cleanup } = await startPlugin(host.context, values.dependencies, [JEV_INIT_SKILL]);

    host.runSkillTransforms();

    const editor = host.runSkillTransforms();

    expect(editor.list().map((skill) => skill.id)).toEqual(["jev-init"]);
    expect(editor.get("jev-init")?.content).toContain("jev-init");
    expect(host.runAgentTransforms().list()).toEqual([]);

    await cleanup();
  });

  test("cleanup never throws when a registration fails to dispose", async () => {
    const values = harness();
    const host = createFakeOpenCodeContext();
    const failing = {
      ...host.context,
      skill: {
        transform: async () => ({
          dispose: async () => {
            throw new Error("dispose failed");
          },
        }),
      },
    } as unknown as Plugin.Context;
    const { cleanup } = await startPlugin(failing, values.dependencies, []);

    await expect(cleanup()).resolves.toBeUndefined();
  });
});

const REMEDIATE = { remediate: { maxAttempts: 2 } } as const;

function deliveryRecord(mark: DeliveryMark, id = "msg_delivery"): OpenCodeMessage {
  return { id, type: "synthetic", completed: false, text: "frame", metadata: { jevguard: mark } };
}

const IDLE_RECORD: OpenCodeMessage = { id: "msg_idle", type: "idle", completed: false };

/** The correction execution: the queued remediation message, then the agent's answer. */
function correctionRecords(
  mark: DeliveryMark,
  extraInputs: readonly OpenCodeMessage[] = [],
): readonly OpenCodeMessage[] {
  return [
    ...turnRecords(),
    IDLE_RECORD,
    ...extraInputs,
    deliveryRecord(mark),
    { id: SECOND_ASSISTANT_ID, type: "assistant", completed: true },
  ];
}

async function firstDelivery(values: Harness): Promise<DeliveryMark> {
  errorFailSetup(values);
  await dispatch(values.runtime, turnEvents());

  const sent = values.origin.sent[0];

  if (sent === undefined) {
    throw new Error("expected a first delivery");
  }

  return sent.mark;
}

function chainResults(values: Harness): readonly string[] {
  return values.chainLog.entries.map((entry) => entry.result);
}

function operationalKinds(values: Harness): readonly string[] {
  return values.operational.events.map((event) => event.kind);
}

describe("JevGuardPlugin remediate (2.2.x)", () => {
  test("queues one visible synthetic delivery, attempt 1/2, after a FAIL", async () => {
    const values = harness(REMEDIATE);

    const mark = await firstDelivery(values);

    expect(mark).toEqual({ chainId: ASSISTANT_ID, attempt: 1, maxAttempts: 2 });
    expect(values.origin.sent).toHaveLength(1);

    const text = values.origin.sent[0]?.text ?? "";

    expect(values.origin.sent[0]?.sessionID).toBe(SESSION_ID);
    expect(text).toContain(`attempt 1/2 · chain ${ASSISTANT_ID}`);
    expect(text).toContain("TEST-1");
    expect(text).toContain(PROPOSER_ANSWER);
    expect(text).not.toContain(PATCH);
    expect(values.navigator.calls).toEqual([]);
    expect(operationalKinds(values)).toEqual(["REMEDIATION_SENT"]);
    expect(values.chainLog.entries).toEqual([]);
    expect(values.facade.forbidden).toEqual([]);
  });

  test("ends the chain as RESOLVED when the correction turn passes", async () => {
    const values = harness(REMEDIATE);
    const mark = await firstDelivery(values);

    values.facade.records = correctionRecords(mark);
    values.jev.probability = 0.1;
    await dispatch(values.runtime, turnEvents());

    expect(values.origin.sent).toHaveLength(1);
    expect(chainResults(values)).toEqual(["RESOLVED"]);
    expect(values.chainLog.entries[0]).toMatchObject({
      host: "opencode",
      chainId: ASSISTANT_ID,
      turnIds: [ASSISTANT_ID, SECOND_ASSISTANT_ID],
      resolvedIds: ["TEST-1"],
      remainingIds: [],
    });
    expect(operationalKinds(values)).toEqual(["REMEDIATION_SENT", "REMEDIATION_RESOLVED"]);
  });

  test("stops on a repeated failure without a second delivery", async () => {
    const values = harness(REMEDIATE);
    const mark = await firstDelivery(values);

    values.facade.records = correctionRecords(mark);
    await dispatch(values.runtime, turnEvents());

    expect(values.origin.sent).toHaveLength(1);
    expect(chainResults(values)).toEqual(["REPEATED_FAILURE"]);
    expect(values.operational.events.at(-1)).toMatchObject({
      kind: "REMEDIATION_STOPPED",
      code: "REPEATED_FAILURE",
    });
  });

  test("ends the chain as UNVERIFIED when a user message joins the correction turn", async () => {
    const values = harness(REMEDIATE);
    const mark = await firstDelivery(values);

    values.facade.records = correctionRecords(mark, [
      { id: SECOND_USER_ID, type: "user", completed: false, text: "Also rename it." },
    ]);
    await dispatch(values.runtime, turnEvents());

    expect(values.origin.sent).toHaveLength(1);
    expect(chainResults(values)).toEqual(["UNVERIFIED"]);
  });

  test("never trusts a pasted frame without the metadata mark", async () => {
    const values = harness(REMEDIATE);
    const mark = await firstDelivery(values);
    const pasted: OpenCodeMessage = {
      id: "msg_pasted",
      type: "user",
      completed: false,
      text: values.origin.sent[0]?.text ?? "",
    };

    values.facade.records = [
      ...turnRecords(),
      IDLE_RECORD,
      pasted,
      { id: SECOND_ASSISTANT_ID, type: "assistant", completed: true },
    ];
    await dispatch(values.runtime, turnEvents());

    // A human turn: a fresh chain starts, and the first one is never judged by it.
    expect(values.origin.sent.map((sent) => sent.mark)).toEqual([
      mark,
      { chainId: SECOND_ASSISTANT_ID, attempt: 1, maxAttempts: 2 },
    ]);
  });

  test("sends nothing into a busy session and ends the chain as UNVERIFIED", async () => {
    const values = harness(REMEDIATE);
    errorFailSetup(values);
    values.proposalFacade.beforeRead = () => {
      values.runtime.onEvent(executionEvent("started"));
    };

    await dispatch(values.runtime, turnEvents());

    expect(values.origin.sent).toEqual([]);
    expect(chainResults(values)).toEqual(["UNVERIFIED"]);
  });

  test("stops at the per-session delivery limit", async () => {
    const values = harness(REMEDIATE);
    errorFailSetup(values);

    for (let index = 1; index <= 4; index += 1) {
      values.facade.records = turnRecords(`msg_assistant_${index}`, `msg_user_${index}`);
      await dispatch(values.runtime, turnEvents());
    }

    expect(values.origin.sent).toHaveLength(3);
    expect(chainResults(values)).toEqual(["SESSION_LIMIT"]);
  });

  test("ends the chain as DELIVERY_FAILED when the synthetic message is rejected", async () => {
    const values = harness(REMEDIATE);
    errorFailSetup(values);
    values.origin.fail = true;

    await dispatch(values.runtime, turnEvents());

    expect(chainResults(values)).toEqual(["DELIVERY_FAILED"]);
    expect(operationalKinds(values)).toEqual(["REMEDIATION_STOPPED"]);
  });

  test("ends the chain as PROPOSAL_FAILED when the proposer fails", async () => {
    const values = harness(REMEDIATE);
    errorFailSetup(values);
    values.proposalFacade.childOutcome = "failed";

    await dispatch(values.runtime, turnEvents());

    expect(values.origin.sent).toEqual([]);
    expect(chainResults(values)).toEqual(["PROPOSAL_FAILED"]);
  });

  test("delivers the findings with an empty strategy when no model is readable", async () => {
    const values = harness(REMEDIATE);
    errorFailSetup(values);
    values.proposalFacade.originModelValue = null;

    await dispatch(values.runtime, turnEvents());

    expect(values.proposalFacade.created).toEqual([]);
    expect(values.origin.sent).toHaveLength(1);
    expect(values.origin.sent[0]?.text).toContain("TEST-1");
    expect(values.origin.sent[0]?.text).not.toContain(PROPOSER_ANSWER);
  });

  test("lets the project's .jev veto remediation", async () => {
    const values = harness(REMEDIATE);
    errorFailSetup(values);
    loadRules(values.policy, scopedRule("error"), DISABLED_CONFIG);

    await dispatch(values.runtime, turnEvents());

    expect(values.origin.sent).toEqual([]);
    expect(values.chainLog.entries).toEqual([]);
  });

  test("ends the session's chain as UNVERIFIED after an interrupted execution", async () => {
    const values = harness(REMEDIATE);
    await firstDelivery(values);

    await dispatch(values.runtime, [executionEvent("started"), executionEvent("interrupted")]);

    expect(chainResults(values)).toEqual(["UNVERIFIED"]);
  });

  test("sends nothing in observe", async () => {
    const values = harness();
    errorFailSetup(values);

    await dispatch(values.runtime, turnEvents());

    expect(values.origin.sent).toEqual([]);
    expect(values.navigator.calls).toEqual([CHILD_SESSION_ID]);
  });
});

describe("JevGuardPlugin remediation chains store", () => {
  test("drops the oldest chain as EXPIRED past the limit", () => {
    const chains = createRemediationChains(2);
    const state = (chainId: string) => ({
      chainId,
      originIds: ["TEST-1"],
      signatures: ["s"],
      turnIds: [chainId],
      attempts: 1,
      scopes: {},
    });

    expect(MAX_ACTIVE_CHAINS).toBe(64);
    expect(chains.save(SESSION_ID, state("a"))).toEqual([]);
    expect(chains.save(SESSION_ID, state("b"))).toEqual([]);
    expect(chains.save(SESSION_ID, state("c"))).toEqual([{ state: state("a"), code: "EXPIRED" }]);
    expect(chains.load("a")).toBeNull();
    expect(chains.activeChain(SESSION_ID)?.chainId).toBe("c");
  });
});

describe("JevGuardPlugin remediation opt-in", () => {
  test("turns remediate on only from an ENABLED remediate user file", () => {
    const host = createFakeOpenCodeContext();
    const enabled = createPluginDependencies(host.context, () => ({
      status: "ENABLED",
      settings: { delivery: "agent", model: null, mode: "remediate", maxAttempts: 3 },
    }));
    const observe = createPluginDependencies(host.context, () => ({
      status: "ENABLED",
      settings: { delivery: "user", model: null, mode: "observe", maxAttempts: 2 },
    }));
    const disabled = createPluginDependencies(host.context, () => ({ status: "DISABLED" }));
    const invalid = createPluginDependencies(host.context, () => ({
      status: "INVALID",
      reason: "USER_CONFIG_IN_PROJECT",
    }));

    expect(enabled.remediation?.maxAttempts).toBe(3);
    expect(observe.remediation).toBeNull();
    expect(disabled.remediation).toBeNull();
    expect(invalid.remediation).toBeNull();
  });
});

const PROPOSER_CHILD_ID = "ses_child_1";
const ORIGIN_HOST_MODEL = { providerID: ORIGIN_MODEL.providerID, id: ORIGIN_MODEL.modelID };

interface ContextRun {
  readonly values: Harness;
  readonly host: FakeOpenCodeContext;
  readonly runtime: PluginRuntime;
  readonly cleanup: () => Promise<void>;
}

/**
 * The plugin end to end over the fake 2.2.x context: the real session, proposal and
 * origin facades read and write through `host`; policy, Jev, presenter and logs stay
 * the harness fakes. The origin session runs `ORIGIN_MODEL` and edits `src/a.ts`.
 */
async function startOnContext(
  options: { readonly remediate?: { readonly maxAttempts: number } } = {},
): Promise<ContextRun> {
  const values = harness(options);
  const host = createFakeOpenCodeContext({ root: "/repo" });
  const remediation = values.dependencies.remediation;

  errorFailSetup(values);
  host.setSession(SESSION_ID, { model: ORIGIN_HOST_MODEL });
  host.setMessages(SESSION_ID, originTurn());
  host.scriptDiffs([], [fileDiff("src/a.ts", PATCH)]);
  host.setChildAnswer(PROPOSER_ANSWER);

  const { runtime, cleanup } = await startPlugin(
    host.context,
    {
      ...values.dependencies,
      tracker: createTurnTracker({
        facade: createOpenCodeSessionFacade(host.context, "/repo"),
        deduplicator: new InMemoryTurnDeduplicator(),
      }),
      proposalFacade: createOpenCodeProposalSessionFacade(host.context),
      remediation:
        remediation === null
          ? null
          : { ...remediation, originPrompt: createOpenCodeOriginPromptFacade(host.context) },
    },
    [],
  );

  return { values, host, runtime, cleanup };
}

function originTurn(): ContextMessage[] {
  return [userMessage(USER_ID, "Implement the thing."), assistantMessage(ASSISTANT_ID)];
}

/** One execution of the origin session through the event stream, then the drain. */
async function hostTurn(run: ContextRun, sessionID: string = SESSION_ID): Promise<void> {
  run.host.emit(hostEvent("started", sessionID));
  run.host.emit(hostEvent("succeeded", sessionID));
  await settle();
  await run.runtime.drain();
}

/** The synthetic message the host stores for the first queued delivery. */
function storedDelivery(run: ContextRun): ContextMessage {
  const call = run.host.calls.synthetic[0];

  if (call === undefined) {
    throw new Error("expected a synthetic delivery");
  }

  return syntheticMessage("msg_delivery", call.text, call.metadata);
}

describe("JevGuardPlugin over the fake 2.2.x context", () => {
  test("observe: a FAIL prompts a deny-all child on the origin model and sends nothing", async () => {
    const run = await startOnContext();

    await hostTurn(run);

    expect(lastReview(run.values.presenter).summary.verdict).toBe("FAIL");
    expect(run.host.calls.diff).toEqual([
      { mode: "working", untracked: "files" },
      { mode: "working", untracked: "files" },
    ]);
    expect(run.host.calls.create).toEqual([
      {
        parentID: SESSION_ID,
        title: "JevGuard remediation proposal",
        model: ORIGIN_HOST_MODEL,
        permissions: [{ action: "*", resource: "*", effect: "deny" }],
      },
    ]);
    expect(run.host.calls.prompt.map((prompt) => prompt.sessionID)).toEqual([PROPOSER_CHILD_ID]);
    expect(run.host.calls.prompt[0]?.text).toContain("TEST-1");
    expect(run.values.notifier.calls).toEqual(["proposalPreparing", "proposalReady"]);
    expect(run.host.calls.synthetic).toEqual([]);

    const child: RetryInput = { sessionID: PROPOSER_CHILD_ID };

    await run.host.fireRetry(child);

    expect(child.decision).toEqual({ retry: false });

    await run.cleanup();
  });

  test("reviews several queued inputs as one execution", async () => {
    const run = await startOnContext();

    run.host.setMessages(SESSION_ID, [
      userMessage(USER_ID, "Implement the thing."),
      userMessage(SECOND_USER_ID, "Also keep it small."),
      assistantMessage(ASSISTANT_ID),
    ]);
    await hostTurn(run);

    expect(run.values.presenter.reviews).toHaveLength(1);
    expect(lastReview(run.values.presenter).turnId).toBe(ASSISTANT_ID);

    await run.cleanup();
  });

  test("never reviews a turn without an edit", async () => {
    const run = await startOnContext();

    run.host.scriptDiffs([]);
    await hostTurn(run);

    expect(run.values.jev.requests).toEqual([]);
    expect(run.host.calls.create).toEqual([]);

    await run.cleanup();
  });

  test.each(["interrupted", "failed"] as const)(
    "never reviews an execution that ends %s",
    async (kind) => {
      const run = await startOnContext();

      run.host.emit(hostEvent("started", SESSION_ID));
      run.host.emit(hostEvent(kind, SESSION_ID));
      await settle();
      await run.runtime.drain();

      expect(run.values.presenter.reviews).toEqual([]);
      expect(run.host.calls.diff).toHaveLength(1);
      expect(run.host.calls.create).toEqual([]);

      await run.cleanup();
    },
  );

  test("remediate: queues one visible synthetic, attempt 1/2, then RESOLVED on the corrected turn", async () => {
    const run = await startOnContext(REMEDIATE);

    await hostTurn(run);

    expect(run.host.calls.synthetic).toHaveLength(1);
    expect(run.host.calls.synthetic[0]).toMatchObject({
      sessionID: SESSION_ID,
      description: "JevGuard remediation",
      delivery: "queue",
      metadata: { jevguard: { chainId: ASSISTANT_ID, attempt: 1, maxAttempts: 2 } },
    });
    expect(run.host.calls.synthetic[0]?.text).toContain(`attempt 1/2 · chain ${ASSISTANT_ID}`);
    expect(run.host.calls.synthetic[0]?.text).toContain(PROPOSER_ANSWER);

    run.host.setMessages(SESSION_ID, [
      ...originTurn(),
      idleMessage("msg_idle"),
      storedDelivery(run),
      assistantMessage(SECOND_ASSISTANT_ID),
    ]);
    run.host.scriptDiffs([], [fileDiff("src/a.ts", PATCH)]);
    run.values.jev.probability = 0.1;
    await hostTurn(run);

    expect(run.host.calls.synthetic).toHaveLength(1);
    expect(chainResults(run.values)).toEqual(["RESOLVED"]);
    expect(run.values.chainLog.entries[0]).toMatchObject({
      chainId: ASSISTANT_ID,
      turnIds: [ASSISTANT_ID, SECOND_ASSISTANT_ID],
    });

    await run.cleanup();
  });

  test("remediate: a user input queued with the delivery leaves the chain UNVERIFIED", async () => {
    const run = await startOnContext(REMEDIATE);

    await hostTurn(run);
    run.host.setMessages(SESSION_ID, [
      ...originTurn(),
      idleMessage("msg_idle"),
      storedDelivery(run),
      userMessage(SECOND_USER_ID, "Also rename it."),
      assistantMessage(SECOND_ASSISTANT_ID),
    ]);
    run.host.scriptDiffs([], [fileDiff("src/a.ts", PATCH)]);
    await hostTurn(run);

    expect(run.host.calls.synthetic).toHaveLength(1);
    expect(chainResults(run.values)).toEqual(["UNVERIFIED"]);

    await run.cleanup();
  });

  test("remediate: a rejected synthetic ends the chain as DELIVERY_FAILED", async () => {
    const run = await startOnContext(REMEDIATE);

    run.host.setSyntheticBehavior("reject");
    await hostTurn(run);

    expect(chainResults(run.values)).toEqual(["DELIVERY_FAILED"]);

    await run.cleanup();
  });

  test("onEvent and the event loop never wait for a pending synthetic delivery", async () => {
    const run = await startOnContext(REMEDIATE);

    run.host.setSyntheticBehavior("hold");
    run.host.emit(hostEvent("started", SESSION_ID));
    run.host.emit(hostEvent("succeeded", SESSION_ID));
    await vi.waitFor(() => expect(run.host.calls.synthetic).toHaveLength(1));

    // The delivery is still pending; another session's execution is reviewed meanwhile.
    run.host.setMessages(SECOND_SESSION_ID, [
      userMessage(SECOND_USER_ID, "Implement the other thing."),
      assistantMessage(SECOND_ASSISTANT_ID),
    ]);
    run.host.scriptDiffs([], [fileDiff("src/b.ts", PATCH)]);
    run.host.emit(hostEvent("started", SECOND_SESSION_ID));
    run.host.emit(hostEvent("succeeded", SECOND_SESSION_ID));
    await vi.waitFor(() => expect(run.values.presenter.reviews).toHaveLength(2));

    expect(operationalKinds(run.values)).not.toContain("REMEDIATION_SENT");

    run.host.releaseSynthetic();
    await run.runtime.drain();

    expect(operationalKinds(run.values)).toContain("REMEDIATION_SENT");

    await run.cleanup();
  });
});
