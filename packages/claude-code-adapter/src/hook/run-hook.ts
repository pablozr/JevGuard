import { isClosingEvent } from "../acquisition";
import { BudgetExceededError, createBudget } from "../capture/budget";
import { captureAfterAppend, captureBeforeAppend } from "../capture/capture-event";
import { closeUnit } from "../capture/close-unit";
import { createRepoPathResolver } from "../capture/file-image";
import type { Budget, CaptureContext, HandoffSink, LineCapture, UnitState } from "../capture/types";
import {
  appendLine,
  handoffDirectoryOf,
  openCurrentUnit,
  recordUnitRoot,
  removeSession,
  stateDirectoryOf,
  sweepOrphans,
  taintSession,
  taintUnit,
} from "../capture/unit-state";
import type { HookEvent } from "../hook-event";
import { isHookEventParseFailure, parseHookEvent } from "../hook-event";
import { isJsonObject } from "../hook-event/shell-diff";
import { appendHookLog } from "./log";
import type { HookDependencies, HookLogCode, HookLogEntry } from "./types";

const HOOK_BUDGET_MS = 20_000;

interface EventScope {
  readonly dependencies: HookDependencies;
  readonly budget: Budget;
  readonly stateDirectory: string;
  readonly log: (code: HookLogCode) => void;
  readonly onHandoffCreated: () => void;
}

function captureOrFail(event: HookEvent, context: CaptureContext): LineCapture | null {
  try {
    return captureBeforeAppend(event, context);
  } catch (error) {
    context.report(
      error instanceof BudgetExceededError ? "HOOK_BUDGET_EXCEEDED" : "CAPTURE_READ_FAILED",
    );

    return { problems: ["CAPTURE_FAILED"] };
  }
}

function captureAfterOrReport(event: HookEvent, context: CaptureContext): void {
  try {
    captureAfterAppend(event, context);
  } catch (error) {
    context.report(
      error instanceof BudgetExceededError ? "HOOK_BUDGET_EXCEEDED" : "CAPTURE_READ_FAILED",
    );
  }
}

function notifyingSink(scope: EventScope): HandoffSink {
  const sink = scope.dependencies.createHandoffSink(handoffDirectoryOf(scope.stateDirectory));

  return {
    deliver(handoff) {
      const delivery = sink.deliver(handoff);

      if (delivery === "CREATED") scope.onHandoffCreated();

      return delivery;
    },
  };
}

function contextFor(scope: EventScope, unit: UnitState, projectRoot: string): CaptureContext {
  const { dependencies } = scope;

  return {
    environment: dependencies.environment,
    files: dependencies.files,
    git: dependencies.git,
    unit,
    projectRoot,
    resolveRepoPath: createRepoPathResolver(projectRoot),
    budget: scope.budget,
    report: scope.log,
  };
}

function trustedProjectRoot(scope: EventScope, unit: UnitState): string | null {
  const projectRoot = scope.dependencies.environment.get("CLAUDE_PROJECT_DIR");

  if (projectRoot === undefined || projectRoot === "") {
    taintUnit(unit);
    scope.log("CAPTURE_READ_FAILED");

    return null;
  }

  if (!recordUnitRoot(unit, projectRoot)) {
    taintUnit(unit);

    return null;
  }

  return projectRoot;
}

function recordEvent(event: HookEvent, scope: EventScope): void {
  const unit = openCurrentUnit(scope.stateDirectory, event.sessionId, scope.dependencies.now());
  const projectRoot = trustedProjectRoot(scope, unit);
  const context = projectRoot === null ? null : contextFor(scope, unit, projectRoot);
  const capture = context === null ? null : captureOrFail(event, context);

  appendLine(unit, capture === null ? { v: 1, event } : { v: 1, event, capture });

  if (context !== null) captureAfterOrReport(event, context);

  if (!isClosingEvent(event)) return;

  const { dependencies } = scope;

  closeUnit({
    unit,
    sessionId: event.sessionId,
    fallbackRoot: event.cwd,
    now: dependencies.now(),
    budget: scope.budget,
    removePath: dependencies.removePath,
    sink: notifyingSink(scope),
    environment: dependencies.environment,
    files: dependencies.files,
    git: dependencies.git,
    report: scope.log,
  });
  sweepContained(scope, event.sessionId);
}

/** Cleanup failures are logged and contained: they say nothing about any unit's evidence. */
function sweepContained(scope: EventScope, keepSessionId: string): void {
  const { dependencies } = scope;

  try {
    sweepOrphans(scope.stateDirectory, dependencies.now(), keepSessionId, dependencies.removePath);
  } catch {
    scope.log("STATE_WRITE_FAILED");
  }
}

function handleEvent(event: HookEvent, scope: EventScope): void {
  if (event.name === "SessionEnd") {
    try {
      removeSession(scope.stateDirectory, event.sessionId, scope.dependencies.removePath);
    } catch {
      scope.log("STATE_WRITE_FAILED");
    }

    return;
  }

  if (event.name === "SessionStart") sweepContained(scope, event.sessionId);

  recordEvent(event, scope);
}

function readableSessionId(payload: unknown): string | null {
  if (!isJsonObject(payload)) return null;

  const sessionId = payload.session_id;

  return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
}

function isFileSystemError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error;
}

function parsePayload(stdin: string): unknown {
  try {
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

/**
 * Processes one hook invocation. Never throws and never writes to stdout or stderr: a
 * failure is logged as a closed code and, when the session is identifiable, marks the
 * open unit as untrustworthy so it can only end `UNAVAILABLE`.
 */
export function runHook(stdin: string, dependencies: HookDependencies): void {
  const pluginData = dependencies.environment.get("CLAUDE_PLUGIN_DATA");

  if (pluginData === undefined || pluginData === "") return;

  const stateDirectory = stateDirectoryOf(pluginData);
  const logFor = (event: HookLogEntry["event"]) => (code: HookLogCode) => {
    appendHookLog(stateDirectory, { timestamp: dependencies.now().toISOString(), event, code });
  };
  const payload = parsePayload(stdin);
  const parsed = parseHookEvent(payload);

  if (isHookEventParseFailure(parsed)) {
    logFor("UNKNOWN")(`PARSE_FAILED:${parsed.reason}`);

    const sessionId = readableSessionId(payload);

    if (sessionId !== null) taintSession(stateDirectory, sessionId, dependencies.now());

    return;
  }

  const log = logFor(parsed.name);
  let workerWanted = parsed.name === "SessionStart";

  try {
    const budget = createBudget(dependencies.monotonicNow, HOOK_BUDGET_MS);

    handleEvent(parsed, {
      dependencies,
      budget,
      stateDirectory,
      log,
      onHandoffCreated: () => {
        workerWanted = true;
      },
    });
  } catch (error) {
    log(isFileSystemError(error) ? "STATE_WRITE_FAILED" : "INTERNAL");
    taintSession(stateDirectory, parsed.sessionId, dependencies.now());
  }

  if (workerWanted) spawnContained(dependencies, log);
}

function spawnContained(dependencies: HookDependencies, log: (code: HookLogCode) => void): void {
  try {
    if (dependencies.spawnWorker() === "ENTRY_MISSING") log("WORKER_ENTRY_MISSING");
  } catch {
    log("WORKER_SPAWN_FAILED");
  }
}
