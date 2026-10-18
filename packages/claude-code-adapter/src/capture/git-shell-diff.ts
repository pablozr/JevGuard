import {
  type CaptureProblem,
  type FileImage,
  type GitShellChange,
  type PostImage,
  sameImage,
  toPostImage,
} from "../acquisition";
import { imageFromBytes, MAX_CAPTURED_FILE_BYTES } from "./file-image";
import { assertStatusEntries, chargeContent, chargeIndexRead, runBounded, text } from "./git-run";
import { observePath } from "./git-shell";
import { ShellDiffLimitError } from "./shell-diff-limits";
import type {
  GitDiffResult,
  GitShellContext,
  ImageReading,
  ObservedPath,
  SnapshotEntry,
  TakenSnapshot,
  UnkeptContentProblem,
} from "./types";

type Step =
  | { readonly kind: "CHANGE"; readonly change: GitShellChange }
  | { readonly kind: "NONE" }
  | { readonly kind: "PROBLEM"; readonly problem: CaptureProblem }
  | { readonly kind: "UNPROVEN" };

const UNPROVEN: GitDiffResult = { status: "FAILED", failure: { kind: "UNPROVEN" } };
const NONE: Step = { kind: "NONE" };
const UNPROVEN_STEP: Step = { kind: "UNPROVEN" };

function headMoves(
  context: GitShellContext,
  toplevel: string,
  preHead: string | null,
  postHead: string | null,
): readonly string[] | null {
  if (preHead === postHead) return [];

  const args =
    preHead !== null && postHead !== null
      ? ["diff-tree", "-r", "-z", "--no-renames", "--name-only", preHead, postHead]
      : ["ls-tree", "-r", "-z", "--full-tree", "--name-only", preHead ?? postHead ?? ""];
  const listed = runBounded(context, args, toplevel);

  if (!listed.ok) return null;

  const paths = text(listed.stdout)
    .split("\0")
    .filter((path) => path !== "");

  assertStatusEntries(context, paths.length);

  return paths;
}

function preHeadSurvives(
  context: GitShellContext,
  pre: TakenSnapshot,
  post: TakenSnapshot,
): boolean {
  const { head, toplevel } = pre.snapshot;

  if (head === null || head === post.snapshot.head) return true;

  return runBounded(context, ["cat-file", "-e", `${head}^{commit}`], toplevel).ok;
}

function readHeadImage(
  context: GitShellContext,
  toplevel: string,
  head: string | null,
  gitPath: string,
): ImageReading | null {
  if (head === null) return { kind: "IMAGE", image: { state: "ABSENT" } };

  chargeIndexRead(context);

  const spec = `${head}:${gitPath}`;
  const exists = runBounded(context, ["cat-file", "-e", spec], toplevel);

  if (!exists.ok) {
    return exists.failure === "EXIT" ? { kind: "IMAGE", image: { state: "ABSENT" } } : null;
  }

  chargeIndexRead(context);

  const filtered = runBounded(context, ["cat-file", "--filters", spec], toplevel, {
    maxOutputBytes: MAX_CAPTURED_FILE_BYTES + 1,
    tolerateOverflow: true,
  });

  if (!filtered.ok && filtered.failure === "OUTPUT_TOO_LARGE") {
    chargeContent(context, MAX_CAPTURED_FILE_BYTES + 1);

    return { kind: "PROBLEM", problem: "CONTENT_TOO_LARGE" };
  }

  if (!filtered.ok) return { kind: "PROBLEM", problem: "CAPTURE_FAILED" };

  chargeContent(context, filtered.stdout.length);

  return imageFromBytes(filtered.stdout);
}

function postImageOf(observed: ObservedPath): PostImage | UnkeptContentProblem | null {
  const { entry, bytes } = observed;

  if (entry.state === "ABSENT") return { state: "ABSENT" };
  if (entry.problem !== undefined) return entry.problem;
  if (bytes === null) return null;

  const reading = imageFromBytes(bytes);

  if (reading.kind === "IMAGE") return toPostImage(reading.image);

  return reading.problem === "CONTENT_TOO_LARGE" || reading.problem === "CONTENT_NOT_TEXT"
    ? reading.problem
    : null;
}

function isProblem(value: PostImage | UnkeptContentProblem): value is UnkeptContentProblem {
  return typeof value === "string";
}

function isStep(value: FileImage | Step): value is Step {
  return "kind" in value;
}

function dirtyPreImage(pre: TakenSnapshot, before: SnapshotEntry): FileImage | Step {
  if (before.state === "ABSENT") return { state: "ABSENT" };
  if (before.problem !== undefined) return { kind: "PROBLEM", problem: before.problem };

  const bytes = pre.contents.get(before.gitPath);

  if (bytes === undefined) return UNPROVEN_STEP;

  const reading = imageFromBytes(bytes);

  return reading.kind === "IMAGE" ? reading.image : { kind: "PROBLEM", problem: reading.problem };
}

function diffDirty(pre: TakenSnapshot, before: SnapshotEntry, after: ObservedPath): Step {
  const { entry } = after;

  if (
    before.kind === entry.kind &&
    before.state === entry.state &&
    before.fingerprint === entry.fingerprint
  ) {
    return NONE;
  }

  if (before.repoPath === null) return UNPROVEN_STEP;
  if (before.kind === "BLOCKED" || entry.kind === "BLOCKED") {
    return { kind: "CHANGE", change: { path: before.repoPath, preState: "UNREAD" } };
  }

  const preImage = dirtyPreImage(pre, before);

  if (isStep(preImage)) return preImage;

  const post = postImageOf(after);

  if (post === null) return UNPROVEN_STEP;
  if (isProblem(post)) return { kind: "PROBLEM", problem: post };

  return {
    kind: "CHANGE",
    change: { path: before.repoPath, preState: "DIRTY", preImage, post },
  };
}

function diffClean(
  context: GitShellContext,
  pre: TakenSnapshot,
  preLinks: ReadonlySet<string>,
  after: ObservedPath,
  gitPath: string,
): Step {
  const { entry } = after;

  if (entry.repoPath === null) return UNPROVEN_STEP;
  if (entry.kind === "BLOCKED" || preLinks.has(gitPath)) {
    return { kind: "CHANGE", change: { path: entry.repoPath, preState: "UNREAD" } };
  }

  const preImage = readHeadImage(context, pre.snapshot.toplevel, pre.snapshot.head, gitPath);

  if (preImage === null) return UNPROVEN_STEP;
  if (preImage.kind === "PROBLEM") return { kind: "PROBLEM", problem: preImage.problem };

  const post = postImageOf(after);

  if (post === null) return UNPROVEN_STEP;
  if (isProblem(post)) return { kind: "PROBLEM", problem: post };
  if (sameImage(preImage.image, post)) return NONE;

  return {
    kind: "CHANGE",
    change: { path: entry.repoPath, preState: "CLEAN", preImage: preImage.image, post },
  };
}

function candidatePaths(
  pre: TakenSnapshot,
  post: TakenSnapshot,
  moved: readonly string[],
): readonly string[] {
  const keys = new Set<string>(moved);

  for (const entry of pre.snapshot.entries) keys.add(entry.gitPath);
  for (const entry of post.snapshot.entries) keys.add(entry.gitPath);

  return [...keys].sort();
}

/**
 * Net change in working-tree content between two snapshots, attributed to one shell call.
 *
 * 1. A different top level is no proof.
 * 2. A HEAD recorded at Pre that moved and no longer names a commit is no proof, since
 *    its blobs can no longer be told apart from absent paths; the check is one Git call
 *    and is not charged as an index read. Candidates are the paths dirty at Pre, dirty at Post, and changed between the HEAD
 *    recorded at Pre and the HEAD at Post (`diff-tree`, or `ls-tree` when one side is
 *    unborn); more than `maxStatusEntries` moved paths is an exceeded limit.
 * 3. A candidate dirty at Pre uses its Pre content as pre-image, verified against its
 *    fingerprint; one whose kind, state and fingerprint are unchanged is not a change. The
 *    fingerprint of content that could not be kept is its stat key, size, mtime, ctime and
 *    inode, so a rewrite that restores size and mtime still differs.
 * 4. A candidate clean at Pre uses its blob in the HEAD recorded at Pre
 *    (`cat-file --filters`), never the current index or HEAD; identical images are not
 *    a change.
 * 5. A blocked path becomes `UNREAD` and is never read; a path outside the project root
 *    is no proof; content that could not be kept is a typed problem.
 * 6. A HEAD or index move alone is not a failure.
 * 7. Reads are charged to the context's meter before they happen; an exceeded limit
 *    makes the diff `FAILED` with that limit, never partial.
 */
export function diffGitSnapshots(
  context: GitShellContext,
  pre: TakenSnapshot,
  post: TakenSnapshot,
): GitDiffResult {
  const { toplevel } = pre.snapshot;

  if (toplevel !== post.snapshot.toplevel) return UNPROVEN;

  const changes: GitShellChange[] = [];
  const problems = new Set<CaptureProblem>();

  try {
    if (!preHeadSurvives(context, pre, post)) return UNPROVEN;

    const moved = headMoves(context, toplevel, pre.snapshot.head, post.snapshot.head);

    if (moved === null) return UNPROVEN;

    const before = new Map(pre.snapshot.entries.map((entry) => [entry.gitPath, entry]));
    const after = new Map(post.snapshot.entries.map((entry) => [entry.gitPath, entry]));
    const preLinks = new Set(pre.snapshot.indexLinks);
    const postLinks = new Set(post.snapshot.indexLinks);

    for (const gitPath of candidatePaths(pre, post, moved)) {
      if (context.budget.expired()) throw new ShellDiffLimitError("TOTAL_TIME");

      const known = after.get(gitPath);
      const observed: ObservedPath =
        known === undefined
          ? observePath(context, toplevel, gitPath, postLinks)
          : { entry: known, bytes: post.contents.get(gitPath) ?? null };
      const was = before.get(gitPath);
      const step =
        was === undefined
          ? diffClean(context, pre, preLinks, observed, gitPath)
          : diffDirty(pre, was, observed);

      if (step.kind === "UNPROVEN") return UNPROVEN;
      if (step.kind === "PROBLEM") problems.add(step.problem);
      if (step.kind === "CHANGE") changes.push(step.change);
    }
  } catch (error) {
    return error instanceof ShellDiffLimitError
      ? { status: "FAILED", failure: { kind: "LIMIT_EXCEEDED", limit: error.limit } }
      : UNPROVEN;
  }

  return { status: "AVAILABLE", changes, problems: [...problems] };
}
