import { resolve } from "node:path";
import type {
  CaptureProblem,
  FileImage,
  GitShellChange,
  GitShellDiff,
  PostImage,
  QuiescentUnit,
  UnitCapture,
} from "../acquisition";
import { acquireUnit, splitQuiescentUnits } from "../acquisition";
import type { HookEvent } from "../hook-event";
import type { TurnResolution } from "../turn";
import { DEFAULT_PATCH_BUDGET_MS, resolveAcquisition, unitTurnId } from "../turn";
import { assertWithinBudget, BudgetExceededError } from "./budget";
import {
  createRepoPathResolver,
  imageFromBytes,
  isReadablePath,
  readFileImage,
} from "./file-image";
import type {
  ClaudeReviewHandoff,
  CloseUnitInput,
  ShellCoverage,
  StoredShellChange,
  UnitState,
} from "./types";
import {
  advanceCurrentOrdinal,
  readBlob,
  readPreRecords,
  readStateLines,
  readUnitRoot,
  removeUnit,
} from "./unit-state";

interface FoldedUnit {
  readonly unit: QuiescentUnit;
  readonly capture: UnitCapture;
  readonly shellCoverage: readonly ShellCoverage[];
}

interface Accumulator {
  readonly postImages: Map<string, Map<string, PostImage>>;
  readonly gitDiffs: Map<string, GitShellDiff>;
  readonly problems: Set<CaptureProblem>;
}

function toolUseIdOf(event: HookEvent): string | null {
  switch (event.name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      return event.tool.toolUseId;
    default:
      return null;
  }
}

function imageFromBlob(unit: UnitState, stored: PostImage): FileImage | null {
  if (stored.state === "ABSENT") return stored;

  const bytes = readBlob(unit, stored.digest);
  const reading = bytes === null ? null : imageFromBytes(bytes);

  return reading !== null && reading.kind === "IMAGE" ? reading.image : null;
}

function hydrateChange(unit: UnitState, change: StoredShellChange): GitShellChange | null {
  if (change.preState === "UNREAD") return change;

  const preImage = imageFromBlob(unit, change.preImage);

  return preImage === null ? null : { ...change, preImage };
}

function hydrateDiff(unit: UnitState, changes: readonly StoredShellChange[]): GitShellDiff | null {
  const hydrated: GitShellChange[] = [];

  for (const change of changes) {
    const item = hydrateChange(unit, change);

    if (item === null) return null;

    hydrated.push(item);
  }

  return { status: "AVAILABLE", changes: hydrated };
}

function collectLines(input: CloseUnitInput, state: Accumulator): readonly HookEvent[] | null {
  const lines = readStateLines(input.unit);

  if (lines === null) return null;

  const events: HookEvent[] = [];

  for (const line of lines) {
    if (!("event" in line)) {
      state.problems.add("CAPTURE_FAILED");
      continue;
    }

    const { event, capture } = line;
    const toolUseId = toolUseIdOf(event);

    events.push(event);

    if (capture === undefined) continue;

    for (const problem of capture.problems ?? []) state.problems.add(problem);

    if (toolUseId === null) continue;

    if (capture.postImages !== undefined) {
      const entries = state.postImages.get(toolUseId) ?? new Map<string, PostImage>();

      for (const { path, image } of capture.postImages) entries.set(path, image);

      state.postImages.set(toolUseId, entries);
    }

    if (capture.gitDiff === undefined) continue;

    const diff =
      capture.gitDiff.status === "FAILED"
        ? capture.gitDiff
        : hydrateDiff(input.unit, capture.gitDiff.changes);

    if (diff === null) state.problems.add("CAPTURE_FAILED");

    state.gitDiffs.set(toolUseId, diff ?? { status: "FAILED", cause: "UNPROVEN" });
  }

  return events;
}

function readPreImages(
  input: CloseUnitInput,
  state: Accumulator,
): { images: Map<string, FileImage>; paths: string[] } {
  const images = new Map<string, FileImage>();
  const records = readPreRecords(input.unit);

  if (records === null) {
    state.problems.add("CAPTURE_FAILED");
    return { images, paths: [] };
  }

  for (const record of records) {
    if ("problem" in record) {
      state.problems.add(record.problem);
      continue;
    }

    const image = imageFromBlob(input.unit, record.image);

    if (image === null) state.problems.add("CAPTURE_FAILED");
    else images.set(record.path, image);
  }

  return { images, paths: records.map((record) => record.path) };
}

function readFinalImages(
  input: CloseUnitInput,
  projectRoot: string,
  paths: ReadonlySet<string>,
  state: Accumulator,
): Map<string, FileImage> {
  const images = new Map<string, FileImage>();

  for (const path of paths) {
    assertWithinBudget(input.budget);

    if (!isReadablePath(path)) continue;

    const reading = readFileImage(input.files, projectRoot, resolve(projectRoot, path));

    if (reading.kind === "IMAGE") {
      images.set(path, reading.image);
      continue;
    }

    if (reading.problem === "CAPTURE_FAILED") input.report("CAPTURE_READ_FAILED");

    state.problems.add(reading.problem);
  }

  return images;
}

function shellCoverageOf(gitDiffs: ReadonlyMap<string, GitShellDiff>): readonly ShellCoverage[] {
  return [...gitDiffs.values()].some((diff) => diff.status === "AVAILABLE")
    ? ["ADAPTER_GIT_DIFF"]
    : [];
}

function foldUnit(input: CloseUnitInput, projectRoot: string): FoldedUnit | null {
  const state: Accumulator = {
    postImages: new Map(),
    gitDiffs: new Map(),
    problems: new Set(),
  };
  const events = collectLines(input, state);

  if (events === null) return null;

  const { closed, open } = splitQuiescentUnits(events);
  const [only] = closed;

  if (closed.length !== 1 || open.length > 0 || only === undefined) return null;

  const pre = readPreImages(input, state);
  const finalPaths = new Set(pre.paths);

  for (const diff of state.gitDiffs.values()) {
    if (diff.status !== "AVAILABLE") continue;

    for (const change of diff.changes) {
      if (change.preState !== "UNREAD") finalPaths.add(change.path);
    }
  }

  return {
    unit: { ...only, ordinal: input.unit.ordinal },
    capture: {
      preImages: pre.images,
      postImages: state.postImages,
      finalImages: readFinalImages(input, projectRoot, finalPaths, state),
      gitDiffs: state.gitDiffs,
      problems: state.problems,
    },
    shellCoverage: shellCoverageOf(state.gitDiffs),
  };
}

function captureFailed(): TurnResolution {
  return { status: "UNAVAILABLE", reason: "MISSING_ATTRIBUTED_DIFF", causes: ["CAPTURE_FAILED"] };
}

interface Resolved {
  readonly resolution: TurnResolution;
  readonly shellCoverage: readonly ShellCoverage[];
}

function resolveUnit(input: CloseUnitInput, projectRoot: string, turnId: string): Resolved {
  const failed: Resolved = { resolution: captureFailed(), shellCoverage: [] };

  try {
    const folded = foldUnit(input, projectRoot);

    if (folded === null) return failed;

    assertWithinBudget(input.budget);

    const acquisition = acquireUnit({
      unit: folded.unit,
      capture: folded.capture,
      resolveRepoPath: createRepoPathResolver(projectRoot),
    });
    const patchBudgetMs = Math.min(DEFAULT_PATCH_BUDGET_MS, input.budget.remainingMs());

    return {
      resolution: resolveAcquisition(acquisition, { turnId, patchBudgetMs }),
      shellCoverage: folded.shellCoverage,
    };
  } catch (error) {
    input.report(
      error instanceof BudgetExceededError ? "HOOK_BUDGET_EXCEEDED" : "CAPTURE_READ_FAILED",
    );

    return failed;
  }
}

function removeClosedUnit(input: CloseUnitInput): void {
  try {
    removeUnit(input.unit, input.removePath);
  } catch {
    input.report("STATE_WRITE_FAILED");
  }
}

/**
 * Closes the unit's state: advances the session to the next unit, acquires the closed
 * unit from its persisted events and captures, delivers one handoff and deletes the
 * unit's state even when delivery fails. An unreadable or malformed unit, or one whose
 * evidence could not be processed in time, becomes an `UNAVAILABLE/CAPTURE_FAILED`
 * handoff rather than being skipped; a cleanup failure never taints the next unit.
 */
export function closeUnit(input: CloseUnitInput): void {
  advanceCurrentOrdinal(input.unit);

  try {
    const projectRoot = readUnitRoot(input.unit) ?? input.fallbackRoot;
    const turnId = unitTurnId(input.sessionId, input.unit.ordinal, input.unit.epoch);
    const { resolution, shellCoverage } = resolveUnit(input, projectRoot, turnId);
    const handoff: ClaudeReviewHandoff = {
      version: 1,
      turnId,
      sessionId: input.sessionId,
      ordinal: input.unit.ordinal,
      epoch: input.unit.epoch,
      projectRoot,
      closedAt: input.now.toISOString(),
      shellCoverage,
      resolution,
    };

    if (input.sink.deliver(handoff) !== "CREATED") input.report("HANDOFF_WRITE_FAILED");
  } finally {
    removeClosedUnit(input);
  }
}
