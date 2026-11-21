import { isClosingEvent } from "../acquisition";
import { BudgetExceededError, createBudget } from "../capture/budget";
import { captureAfterAppend, captureBeforeAppend } from "../capture/capture-event";
import { closeUnit } from "../capture/close-unit";
import { createRepoPathResolver } from "../capture/file-image";
import { type RootLookup, rootCandidateOf } from "../capture/project-root";
import { DEFAULT_SHELL_DIFF_LIMITS } from "../capture/shell-diff-limits";
import type { Budget, CaptureContext, HandoffSink, LineCapture, UnitState } from "../capture/types";
import {
  appendLine,
  handoffDirectoryOf,
  openCurrentUnit,
  readUnitRoot,
  recordUnitRoot,
  removeSession,
  stateDirectoryOf,
  sweepOrphans,
  taintSession,
  taintUnitWith,
} from "../capture/unit-state";
import type { EnforceClosedUnit } from "../enforce/types";
import type { HookEvent } from "../hook-event";
import { isHookEventParseFailure, parseHookEvent } from "../hook-event";
import { isJsonObject } from "../hook-event/shell-diff";
import { unitTurnId } from "../turn";
import { appendHookLog } from "./log";
import type { HookDependencies, HookLogCode, HookLogEntry } from "./types";

/** The hook's own time allowance; the host allows the `Stop` hook 30 s of wall time. */
export const HOOK_BUDGET_MS = 20_000;

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

function notifyingSink(scope: EventScope, onCreated: () => void): HandoffSink {
  const sink = scope.dependencies.createHandoffSink(handoffDirectoryOf(scope.stateDirectory));

  return {
    deliver(handoff) {
      const delivery = sink.deliver(handoff);

      if (delivery === "CREATED") {
        onCreated();
        scope.onHandoffCreated();
      }

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
    monotonicNow: dependencies.monotonicNow,
    shellDiffLimits: dependencies.shellDiffLimits ?? DEFAULT_SHELL_DIFF_LIMITS,
    report: scope.log,
  };
}

/**
 * Where the unit is judged (ADR 0018): `KNOWN` once its own evidence named a work tree,
 * `PENDING` while no event has named one — nothing is recorded, so nothing is keyed by a
 * place that is not the unit's yet — and `UNRESOLVED` when a call that can write ran from
 * outside every work tree before the root was known, which leaves no proof at all.
 */
type RootReading =
  | { readonly status: "KNOWN"; readonly root: string }
  | { readonly status: "PENDING" }
  | { readonly status: "UNRESOLVED" };

/** A call whose effects only a Git picture proves, so its place decides the unit's root. */
function namesAFencedCall(event: HookEvent): boolean {
  if (!("tool" in event)) return false;

  const { category } = event.tool;

  return category === "BASH" || category === "POWERSHELL" || category === "MCP";
}

function rootLookup(scope: EventScope): RootLookup {
  const { dependencies } = scope;

  const fallbackRoot = dependencies.environment.get("CLAUDE_PROJECT_DIR");

  return {
    files: dependencies.files,
    git: dependencies.git,
    limits: dependencies.shellDiffLimits ?? DEFAULT_SHELL_DIFF_LIMITS,
    fallbackRoot: fallbackRoot === undefined || fallbackRoot === "" ? null : fallbackRoot,
  };
}

function unitRoot(scope: EventScope, unit: UnitState, event: HookEvent): RootReading {
  const recorded = readUnitRoot(unit);

  if (recorded !== null) return { status: "KNOWN", root: recorded };

  const candidate = rootCandidateOf(event, rootLookup(scope));

  if (candidate.status === "NOT_EVIDENCE") return { status: "PENDING" };

  if (candidate.status === "NO_PLACE") {
    return namesAFencedCall(event) ? { status: "UNRESOLVED" } : { status: "PENDING" };
  }

  if (recordUnitRoot(unit, candidate.toplevel)) {
    return { status: "KNOWN", root: candidate.toplevel };
  }

  const winner = readUnitRoot(unit);

  if (winner === null) return { status: "UNRESOLVED" };
  if (winner === candidate.toplevel) return { status: "KNOWN", root: winner };

  taintUnitWith(unit, "MULTIPLE_REPOSITORIES");

  return { status: "KNOWN", root: winner };
}

/** A tool name is safe to log; anything unexpected about it is dropped, not escaped. */
function loggedToolName(toolName: string): string {
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(toolName) ? toolName : "?";
}

/**
 * Records the name of a tool the closed list does not know, so a missing read-only or
 * coordination entry can be found from the log. Only the name goes to the log: no input,
 * no path, no task text. One line per call, on its `PreToolUse`: the same call would
 * otherwise be logged again when its `Post` arrives.
 */
function logUnknownTool(event: HookEvent, scope: EventScope): void {
  if (event.name !== "PreToolUse" || event.tool.category !== "UNKNOWN") return;

  scope.log(`UNKNOWN_TOOL:${loggedToolName(event.tool.toolName)}`);
}

function recordEvent(event: HookEvent, scope: EventScope): EnforceClosedUnit | null {
  logUnknownTool(event, scope);

  const unit = openCurrentUnit(scope.stateDirectory, event.sessionId, scope.dependencies.now());
  const reading = unitRoot(scope, unit, event);

  if (reading.status === "UNRESOLVED") taintUnitWith(unit, "PROJECT_ROOT_UNRESOLVED");

  const context = reading.status === "KNOWN" ? contextFor(scope, unit, reading.root) : null;
  const capture = context === null ? null : captureOrFail(event, context);

  appendLine(unit, capture === null ? { v: 1, event } : { v: 1, event, capture });

  if (context !== null) captureAfterOrReport(event, context);

  if (!isClosingEvent(event)) return null;

  const { dependencies } = scope;
  const projectRoot = readUnitRoot(unit) ?? event.cwd;
  let handoffCreated = false;

  closeUnit({
    unit,
    sessionId: event.sessionId,
    fallbackRoot: event.cwd,
    now: dependencies.now(),
    budget: scope.budget,
    removePath: dependencies.removePath,
    sink: notifyingSink(scope, () => {
      handoffCreated = true;
    }),
    environment: dependencies.environment,
    files: dependencies.files,
    git: dependencies.git,
    report: scope.log,
  });
  sweepContained(scope, event.sessionId);

  return {
    sessionId: event.sessionId,
    sessionDirectory: unit.sessionDirectory,
    turnId: unitTurnId(event.sessionId, unit.ordinal, unit.epoch),
    projectRoot,
    epoch: unit.epoch,
    ordinal: unit.ordinal,
    handoffCreated,
  };
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

function handleEvent(event: HookEvent, scope: EventScope): EnforceClosedUnit | null {
  if (event.name === "SessionEnd") {
    try {
      removeSession(scope.stateDirectory, event.sessionId, scope.dependencies.removePath);
    } catch {
      scope.log("STATE_WRITE_FAILED");
    }

    return null;
  }

  if (event.name === "SessionStart") sweepContained(scope, event.sessionId);

  return recordEvent(event, scope);
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

/** What one invocation processed: the parsed event and, when it closed one, the unit. */
export interface HookResult {
  readonly event: HookEvent | null;
  readonly closed: EnforceClosedUnit | null;
}

const NOTHING_PROCESSED: HookResult = { event: null, closed: null };

/**
 * Processes one hook invocation. Never throws and never writes to stdout or stderr: a
 * failure is logged as a closed code and, when the session is identifiable, marks the
 * open unit as untrustworthy so it can only end `UNAVAILABLE`. It answers with the unit
 * a closing event produced, which the `Stop` gate needs; the decision itself is printed
 * by the process entry, never here.
 */
export function runHook(stdin: string, dependencies: HookDependencies): HookResult {
  const pluginData = dependencies.environment.get("CLAUDE_PLUGIN_DATA");

  if (pluginData === undefined || pluginData === "") return NOTHING_PROCESSED;

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

    return NOTHING_PROCESSED;
  }

  const log = logFor(parsed.name);
  let workerWanted = parsed.name === "SessionStart";
  let closed: EnforceClosedUnit | null = null;

  try {
    const budget = createBudget(dependencies.monotonicNow, HOOK_BUDGET_MS);

    closed = handleEvent(parsed, {
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

  return { event: parsed, closed };
}

function spawnContained(dependencies: HookDependencies, log: (code: HookLogCode) => void): void {
  try {
    if (dependencies.spawnWorker() === "ENTRY_MISSING") log("WORKER_ENTRY_MISSING");
  } catch {
    log("WORKER_SPAWN_FAILED");
  }
}
