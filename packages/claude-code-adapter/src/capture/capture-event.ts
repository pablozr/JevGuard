import { resolve } from "node:path";
import {
  type CaptureProblem,
  type GitShellChange,
  type GitShellDiffFailure,
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
  readStateLines,
  takeShellSnapshot,
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

function isShellTool(event: { readonly tool: { readonly category: string } }): boolean {
  return event.tool.category === "BASH" || event.tool.category === "POWERSHELL";
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

      return category === "EDIT" || category === "BASH" || category === "POWERSHELL"
        ? event.tool.toolUseId
        : null;
    }
    default:
      return null;
  }
}

function overlapsAnotherWriter(context: CaptureContext, toolUseId: string): boolean {
  const lines = readStateLines(context.unit);

  if (lines === null) return true;

  const pending = new Set<string>();
  let started = false;

  for (const line of lines) {
    if (!("event" in line)) continue;

    const id = isWriteCapable(line.event);

    if (id === null) continue;

    if (line.event.name === "PreToolUse" && id === toolUseId) {
      if (pending.size > 0) return true;

      started = true;
      continue;
    }

    if (started) return true;

    if (line.event.name === "PreToolUse") pending.add(id);
    else pending.delete(id);
  }

  return !started;
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

  const pre = takeShellSnapshot(context.unit, event.tool.toolUseId);

  if (overlapsAnotherWriter(context, event.tool.toolUseId) || pre.status === "MISSING") {
    return failedShellCapture("UNPROVEN");
  }

  if (pre.status === "LIMIT_EXCEEDED") return failedShellCapture("LIMIT_EXCEEDED");

  const shell = shellDiffContext(context);
  const post = takeGitSnapshot(shell, event.cwd);
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
    case "PreToolUse":
      return event.tool.category === "EDIT" ? capturePreEdit(event, context) : null;
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
 * The shell pre-call snapshot is taken after the event line is appended, so the line
 * marks the start of the window that overlap detection looks at.
 */
export function captureAfterAppend(event: HookEvent, context: CaptureContext): void {
  if (event.name !== "PreToolUse" || !isShellTool(event)) return;
  if (event.tool.runInBackground || !isEnabledShellDiff(context)) return;

  const result = takeGitSnapshot(shellDiffContext(context), event.cwd);

  if (result.status === "TAKEN") {
    writeShellSnapshot(context.unit, event.tool.toolUseId, result);
    return;
  }

  reportShellFailure(context, result.failure);

  if (result.failure.kind === "LIMIT_EXCEEDED") {
    writeShellSnapshotLimit(context.unit, event.tool.toolUseId);
  }
}
