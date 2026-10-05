import { resolve } from "node:path";
import type { CaptureProblem, FileImage, GitShellChange, PostImage } from "../acquisition";
import type {
  HookEvent,
  PostToolUseEvent,
  PostToolUseFailureEvent,
  PreToolUseEvent,
} from "../hook-event";
import { assertWithinBudget } from "./budget";
import { isReadablePath, readFileImage } from "./file-image";
import { diffGitSnapshots, takeGitSnapshot } from "./git-shell";
import type {
  CaptureContext,
  ImageReading,
  LineCapture,
  PreRecord,
  StoredGitDiff,
  StoredShellChange,
} from "./types";
import {
  readStateLines,
  takeShellSnapshot,
  writeBlob,
  writeFirstPreRecord,
  writeShellSnapshot,
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

function toPostImage(image: FileImage): PostImage {
  return image.state === "ABSENT" ? image : { state: "PRESENT", digest: image.digest };
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
  if (change.preState !== "CLEAN") return change;

  if (change.indexImage.state === "PRESENT") {
    writeBlob(context.unit, Buffer.from(change.indexImage.content, "utf8"));
  }

  return { ...change, indexImage: toPostImage(change.indexImage) };
}

function crossCheckBashEditDiff(
  event: PostToolUseEvent,
  gitDiff: StoredGitDiff,
  context: CaptureContext,
): void {
  if (event.tool.category !== "BASH") return;

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

function capturePostShell(
  event: PostToolUseEvent | PostToolUseFailureEvent,
  context: CaptureContext,
): LineCapture | null {
  if (event.tool.runInBackground || !isEnabledShellDiff(context)) return null;

  const post = takeGitSnapshot(context, event.cwd);
  const pre = takeShellSnapshot(context.unit, event.tool.toolUseId);

  if (post === null || pre === null) {
    if (post === null) context.report("GIT_FAILED");

    return lineCapture({ gitDiff: { status: "FAILED" } });
  }

  if (overlapsAnotherWriter(context, event.tool.toolUseId)) {
    return lineCapture({ gitDiff: { status: "FAILED" } });
  }

  const { diff, problems } = diffGitSnapshots(context, pre, post);
  const gitDiff: StoredGitDiff =
    diff.status === "AVAILABLE"
      ? { status: "AVAILABLE", changes: diff.changes.map((item) => toStoredChange(item, context)) }
      : { status: "FAILED" };

  if (event.name === "PostToolUse") crossCheckBashEditDiff(event, gitDiff, context);

  return lineCapture({ gitDiff, problems });
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

  const snapshot = takeGitSnapshot(context, event.cwd);

  if (snapshot === null) {
    context.report("GIT_FAILED");
    return;
  }

  writeShellSnapshot(context.unit, event.tool.toolUseId, snapshot);
}
