import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type CaptureProblem,
  type GitShellChange,
  type GitShellDiffFailure,
  type McpBatch,
  openMcpBatch,
  type PostImage,
  toPostImage,
} from "../acquisition";
import type {
  HookEvent,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
} from "../hook-event";
import { assertWithinBudget, narrowBudget } from "./budget";
import { isReadablePath, readFileImage } from "./file-image";
import { takeGitSnapshot } from "./git-shell";
import { diffGitSnapshots } from "./git-shell-diff";
import { rootCandidateOf } from "./project-root";
import { createShellDiffMeter } from "./shell-diff-limits";
import type {
  CaptureContext,
  GitShellContext,
  ImageReading,
  LineCapture,
  PreRecord,
  ShellDiffFailure,
  StoredGitDiff,
  StoredShellChange,
} from "./types";
import {
  hasShellSnapshot,
  isShellBatchUnproven,
  markShellBatchUnproven,
  readStateLines,
  takeShellSnapshot,
  taintUnitWith,
  writeBlob,
  writeFirstPreRecord,
  writeShellSnapshot,
  writeShellSnapshotLimit,
} from "./unit-state";

interface CaptureParts {
  readonly postImages?: readonly { readonly path: string; readonly image: PostImage }[] | undefined;
  readonly gitDiff?: StoredGitDiff | undefined;
  readonly problems?: readonly CaptureProblem[] | undefined;
}

const SHELL_GIT_DIFF_SWITCH = "JEVGUARD_CLAUDE_SHELL_GIT_DIFF";

function lineCapture(parts: CaptureParts): LineCapture {
  const { postImages, gitDiff, problems } = parts;

  return {
    ...(postImages === undefined ? {} : { postImages }),
    ...(gitDiff === undefined ? {} : { gitDiff }),
    ...(problems === undefined || problems.length === 0 ? {} : { problems }),
  };
}

function isEnabledShellDiff(context: CaptureContext): boolean {
  return context.environment.get(SHELL_GIT_DIFF_SWITCH) !== "0";
}

/** Shell and MCP calls are fenced by the same Git snapshot (ADR 0017). */
function isShellTool(event: { readonly tool: { readonly category: string } }): boolean {
  const { category } = event.tool;

  return category === "BASH" || category === "POWERSHELL" || category === "MCP";
}

function readableRepoPath(rawPath: string, cwd: string, context: CaptureContext): string | null {
  const repoPath = context.resolveRepoPath(rawPath, cwd);

  return repoPath !== null && isReadablePath(repoPath) ? repoPath : null;
}

function readProjectFile(context: CaptureContext, repoPath: string): ImageReading {
  const reading = readFileImage(
    context.files,
    context.projectRoot,
    resolve(context.projectRoot, repoPath),
  );

  if (reading.kind === "PROBLEM" && reading.problem === "CAPTURE_FAILED") {
    context.report("CAPTURE_READ_FAILED");
  }

  return reading;
}

function readPostImages(
  context: CaptureContext,
  repoPaths: readonly string[],
): Pick<CaptureParts, "postImages" | "problems"> {
  const postImages: { path: string; image: PostImage }[] = [];
  const problems = new Set<CaptureProblem>();

  for (const path of repoPaths) {
    assertWithinBudget(context.budget);

    const reading = readProjectFile(context, path);

    if (reading.kind === "PROBLEM") problems.add(reading.problem);
    else postImages.push({ path, image: toPostImage(reading.image) });
  }

  return { postImages, problems: [...problems] };
}

function preRecordOf(context: CaptureContext, repoPath: string): PreRecord {
  const reading = readProjectFile(context, repoPath);

  if (reading.kind === "PROBLEM") return { v: 1, path: repoPath, problem: reading.problem };
  if (reading.image.state === "ABSENT") return { v: 1, path: repoPath, image: reading.image };

  writeBlob(context.unit, Buffer.from(reading.image.content, "utf8"));

  return { v: 1, path: repoPath, image: toPostImage(reading.image) };
}

const MAX_ANCESTOR_STEPS = 40;

function isWithin(root: string, path: string): boolean {
  const inside = relative(resolve(root), resolve(path));

  return inside === "" || (!isAbsolute(inside) && !inside.startsWith(".."));
}

/**
 * The nearest directory strictly below the unit's root that holds a `.git` entry. A file of
 * a nested repository resolves inside the outer root, so the walk is what tells it apart
 * before any Git call: an ordinary edit costs a few `stat`s and no Git process (issue #88).
 */
function nestedRepositoryOf(context: CaptureContext, start: string): string | null {
  const root = resolve(context.projectRoot);
  let current = resolve(start);

  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    if (!isWithin(root, current) || current === root) return null;
    if (context.files.stat(resolve(current, ".git")) !== null) return current;

    const parent = dirname(current);

    if (parent === current) return null;

    current = parent;
  }

  return null;
}

/**
 * An edit outside the unit's root can still belong to another work tree, and then the unit
 * spans two repositories: the review would judge one repository's change by another's
 * policy, so it is `UNAVAILABLE` with its own reason (ADR 0018).
 *
 * A nested repository resolves inside the outer root, so the path alone does not say whether
 * it is the unit's repository; the walk that finds its `.git` does. Once it is found, the
 * edit is another repository's unless the place proves the unit's own root: an answer the
 * edit cannot get at all (a `rev-parse` that fails there, as on Windows without
 * `safe.directory`) is not proof that it belongs to the outer repository (issue #88).
 */
function noteForeignEdit(event: PreToolUseEvent, context: CaptureContext): void {
  if (event.tool.filePath === null) return;

  const absolute = resolve(event.cwd, event.tool.filePath);
  const insideUnit = context.resolveRepoPath(event.tool.filePath, event.cwd) !== null;
  const nested = insideUnit ? nestedRepositoryOf(context, dirname(absolute)) : null;

  if (insideUnit && nested === null) return;

  const candidate = rootCandidateOf(event, {
    files: context.files,
    git: context.git,
    limits: context.shellDiffLimits,
    fallbackRoot: null,
  });

  if (candidate.status === "PLACE" && candidate.toplevel === context.projectRoot) return;

  // Outside the root only a proven other work tree makes the unit span two repositories;
  // inside it, a nested repository the walk found counts even when the place cannot answer.
  if (nested !== null || candidate.status === "PLACE") {
    taintUnitWith(context.unit, "MULTIPLE_REPOSITORIES");
  }
}

function capturePreEdit(event: PreToolUseEvent, context: CaptureContext): null {
  if (event.tool.filePath === null) return null;

  const repoPath = readableRepoPath(event.tool.filePath, event.cwd, context);

  if (repoPath === null) return null;

  writeFirstPreRecord(context.unit, repoPath, () => preRecordOf(context, repoPath));

  return null;
}

function isWriteCapable(event: HookEvent): string | null {
  switch (event.name) {
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      const { category } = event.tool;

      return category === "EDIT" || isShellTool(event) ? event.tool.toolUseId : null;
    }
    default:
      return null;
  }
}

/** The unit's events so far; `null` when the state cannot be read at all. */
function stateEvents(context: CaptureContext): readonly HookEvent[] | null {
  const lines = readStateLines(context.unit);

  if (lines === null) return null;

  const events: HookEvent[] = [];

  for (const line of lines) {
    if ("event" in line) events.push(line.event);
  }

  return events;
}

function overlapsAnotherWriter(events: readonly HookEvent[], toolUseId: string): boolean {
  const pending = new Set<string>();
  let started = false;

  for (const event of events) {
    const id = isWriteCapable(event);

    if (id === null) continue;

    if (event.name === "PreToolUse" && id === toolUseId) {
      if (pending.size > 0) return true;

      started = true;
      continue;
    }

    if (started) return true;

    if (event.name === "PreToolUse") pending.add(id);
    else pending.delete(id);
  }

  return !started;
}

/**
 * `true` when a call that is not a member of the batch overlaps its window: another shell
 * call, or an edit whose own pre/post images are a different kind of evidence. The batch's
 * snapshot cannot separate the two writers, so the batch has no proof.
 */
function overlapsForeignWriter(events: readonly HookEvent[], batch: McpBatch): boolean {
  const members = new Set(batch.memberIds);
  const pending = new Set<string>();
  let inside = false;

  for (const event of events) {
    const id = isWriteCapable(event);

    if (id === null) continue;

    if (!inside) {
      if (event.name !== "PreToolUse") {
        pending.delete(id);
        continue;
      }

      if (members.has(id) && id === batch.baseId) {
        inside = true;

        if (pending.size > 0) return true;

        continue;
      }

      pending.add(id);
      continue;
    }

    if (!members.has(id)) return true;
  }

  return false;
}

function toStoredChange(change: GitShellChange, context: CaptureContext): StoredShellChange {
  if (change.preState === "UNREAD") return change;

  if (change.preImage.state === "PRESENT") {
    writeBlob(context.unit, Buffer.from(change.preImage.content, "utf8"));
  }

  return { ...change, preImage: toPostImage(change.preImage) };
}

function crossCheckBashEditDiff(
  event: PostToolUseEvent,
  gitDiff: StoredGitDiff,
  context: CaptureContext,
): void {
  if (event.tool.category !== "BASH" || event.shellDiff.status === "ABSENT") return;

  if (event.shellDiff.status !== "PRESENT" || gitDiff.status !== "AVAILABLE") {
    context.report("SHELL_CROSS_CHECK_UNAVAILABLE");
    return;
  }

  const reported = new Set<string | null>(
    event.shellDiff.changedFiles.map((rawPath) => context.resolveRepoPath(rawPath, event.cwd)),
  );
  const observed = new Set<string | null>(gitDiff.changes.map((change) => change.path));
  const agree =
    reported.size === observed.size && [...reported].every((path) => observed.has(path));

  context.report(agree ? "SHELL_CROSS_CHECK_AGREE" : "SHELL_CROSS_CHECK_DISAGREE");
}

function shellDiffContext(context: CaptureContext): GitShellContext {
  const { shellDiffLimits } = context;

  return {
    git: context.git,
    files: context.files,
    projectRoot: context.projectRoot,
    resolveRepoPath: context.resolveRepoPath,
    budget: narrowBudget(context.budget, context.monotonicNow, shellDiffLimits.timeMs),
    limits: shellDiffLimits,
    meter: createShellDiffMeter(shellDiffLimits),
  };
}

function failedShellCapture(cause: GitShellDiffFailure): LineCapture {
  return lineCapture({ gitDiff: { status: "FAILED", cause } });
}

function reportShellFailure(context: CaptureContext, failure: ShellDiffFailure): void {
  context.report(
    failure.kind === "LIMIT_EXCEEDED" ? `SHELL_DIFF_LIMIT:${failure.limit}` : "GIT_FAILED",
  );
}

function capturePostShell(
  event: PostToolUseEvent | PostToolUseFailureEvent,
  context: CaptureContext,
): LineCapture | null {
  if (event.tool.runInBackground || !isEnabledShellDiff(context)) return null;

  const events = stateEvents(context);

  if (events === null) return failedShellCapture("UNPROVEN");

  return event.tool.category === "MCP"
    ? capturePostMcp(event, events, context)
    : closingDiff(
        event.tool.toolUseId,
        overlapsAnotherWriter(events, event.tool.toolUseId),
        event,
        context,
      );
}

/**
 * An MCP call that starts while another MCP call of the unit is open joins its batch and
 * takes no snapshot of its own: the batch is fenced once, and only its last member holds
 * the diff (ADR 0017, addendum). A member therefore reports no evidence here, and the
 * closer diffs the whole batch against the base snapshot.
 */
function capturePostMcp(
  event: PostToolUseEvent | PostToolUseFailureEvent,
  events: readonly HookEvent[],
  context: CaptureContext,
): LineCapture | null {
  const batch = openMcpBatch(events);

  if (batch === null || !batch.memberIds.includes(event.tool.toolUseId)) {
    return failedShellCapture("UNPROVEN");
  }

  if (batch.openIds.some((id) => id !== event.tool.toolUseId)) return null;

  return closingDiff(
    batch.baseId,
    overlapsForeignWriter(events, batch) || isShellBatchUnproven(context.unit, batch.baseId),
    event,
    context,
  );
}

/** Diffs the closing snapshot against the base one, or says why there is no proof. */
function closingDiff(
  baseId: string,
  unproven: boolean,
  event: PostToolUseEvent | PostToolUseFailureEvent,
  context: CaptureContext,
): LineCapture {
  if (unproven) return failedShellCapture("UNPROVEN");

  const pre = takeShellSnapshot(context.unit, baseId);

  if (pre.status === "MISSING") return failedShellCapture("UNPROVEN");

  if (pre.status === "LIMIT_EXCEEDED") return failedShellCapture("LIMIT_EXCEEDED");

  const shell = shellDiffContext(context);
  const post = takeGitSnapshot(shell, event.cwd);

  if (post.status === "TAKEN" && post.foreign === true) {
    taintUnitWith(context.unit, "MULTIPLE_REPOSITORIES");

    return failedShellCapture("UNPROVEN");
  }

  const result = post.status === "TAKEN" ? diffGitSnapshots(shell, pre, post) : post;

  if (result.status === "FAILED") {
    reportShellFailure(context, result.failure);

    return failedShellCapture(result.failure.kind);
  }

  const gitDiff: StoredGitDiff = {
    status: "AVAILABLE",
    changes: result.changes.map((item) => toStoredChange(item, context)),
  };

  if (event.name === "PostToolUse") crossCheckBashEditDiff(event, gitDiff, context);

  return lineCapture({ gitDiff, problems: result.problems });
}

function captureEditPost(event: PostToolUseEvent, context: CaptureContext): LineCapture | null {
  if (event.tool.filePath === null) return null;

  const repoPath = readableRepoPath(event.tool.filePath, event.cwd, context);

  return repoPath === null ? null : lineCapture(readPostImages(context, [repoPath]));
}

/**
 * Evidence that must be on disk before the event's own line is appended: a first
 * pre-image (written to its own record), post-image digests of edits and the
 * shell Git diff.
 */
export function captureBeforeAppend(event: HookEvent, context: CaptureContext): LineCapture | null {
  assertWithinBudget(context.budget);

  switch (event.name) {
    case "PreToolUse": {
      if (event.tool.category !== "EDIT") return null;

      noteForeignEdit(event, context);

      return capturePreEdit(event, context);
    }
    case "PostToolUse":
      if (event.tool.category === "EDIT") return captureEditPost(event, context);

      return isShellTool(event) ? capturePostShell(event, context) : null;
    case "PostToolUseFailure":
      return isShellTool(event) ? capturePostShell(event, context) : null;
    default:
      return null;
  }
}

/**
 * `true` when this MCP call starts while another MCP call of the unit is still open, so
 * the open batch already fences it and the call must not fence itself. Hook processes do
 * not share a lock: a member that arrives while the base snapshot is still being taken
 * comes before the fence, and a write of its server can land inside that picture. The
 * batch is then marked without proof instead of silently attributing less than happened.
 *
 * The base call never joins its own batch. Its line can be followed by a member's line
 * before its state read, and then `openIds` holds another id while this call is still the
 * one that must take the fence (#89): skipping here would leave the whole batch without a
 * base snapshot and make every member `UNAVAILABLE`.
 */
function joinsOpenMcpBatch(event: PreToolUseEvent, context: CaptureContext): boolean {
  if (event.tool.category !== "MCP") return false;

  const events = stateEvents(context);
  const open = events === null ? null : openMcpBatch(events);

  if (open === null || event.tool.toolUseId === open.baseId) return false;

  if (!open.openIds.some((id) => id !== event.tool.toolUseId)) return false;

  if (!hasShellSnapshot(context.unit, open.baseId)) {
    markShellBatchUnproven(context.unit, open.baseId);
  }

  return true;
}

/**
 * The shell pre-call snapshot is taken after the event line is appended, so the line
 * marks the start of the window that overlap detection looks at.
 */
export function captureAfterAppend(event: HookEvent, context: CaptureContext): void {
  if (event.name !== "PreToolUse" || !isShellTool(event)) return;
  if (event.tool.runInBackground || !isEnabledShellDiff(context)) return;
  if (joinsOpenMcpBatch(event, context)) return;

  const result = takeGitSnapshot(shellDiffContext(context), event.cwd);

  if (result.status === "TAKEN" && result.foreign !== true) {
    writeShellSnapshot(context.unit, event.tool.toolUseId, result);
    return;
  }

  if (result.status === "TAKEN") {
    taintUnitWith(context.unit, "MULTIPLE_REPOSITORIES");
    return;
  }

  reportShellFailure(context, result.failure);

  if (result.failure.kind === "LIMIT_EXCEEDED") {
    writeShellSnapshotLimit(context.unit, event.tool.toolUseId);
  }
}
