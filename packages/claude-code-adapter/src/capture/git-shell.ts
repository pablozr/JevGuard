import { resolve } from "node:path";
import type { CaptureProblem, GitShellChange } from "../acquisition";
import {
  guardPath,
  imageFromBytes,
  isReadablePath,
  MAX_CAPTURED_FILE_BYTES,
  readFileImage,
  sha256Hex,
} from "./file-image";
import { ShellDiffLimitError } from "./shell-diff-limits";
import type {
  CaptureFileReader,
  GitDiffResult,
  GitRunOptions,
  GitRunResult,
  GitShellContext,
  GitSnapshot,
  ImageReading,
  SnapshotEntry,
  SnapshotResult,
} from "./types";

interface BoundedRun extends GitRunOptions {
  /** Return an output overflow to the caller instead of treating it as a limit. */
  readonly tolerateOverflow?: boolean;
}

const SYMLINK_MODE = "120000";

const STATUS_ARGS = [
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
];
const DECODER = new TextDecoder();

function text(bytes: Uint8Array): string {
  return DECODER.decode(bytes);
}

function runBounded(
  context: GitShellContext,
  args: readonly string[],
  cwd: string,
  options: BoundedRun = {},
): GitRunResult {
  const { budget, limits } = context;

  if (budget.expired()) throw new ShellDiffLimitError("TOTAL_TIME");

  const remainingMs = budget.remainingMs();
  const callOwnsTimeout = limits.gitCallTimeoutMs <= remainingMs;
  const timeoutMs = Math.max(1, Math.ceil(Math.min(limits.gitCallTimeoutMs, remainingMs)));
  const maxOutputBytes = options.maxOutputBytes ?? limits.maxGitOutputBytes;
  const result = context.git(args, cwd, {
    ...(options.input === undefined ? {} : { input: options.input }),
    timeoutMs,
    maxOutputBytes,
  });

  if (result.ok) return result;

  if (result.failure === "TIMEOUT") {
    throw new ShellDiffLimitError(callOwnsTimeout ? "GIT_CALL_TIME" : "TOTAL_TIME");
  }

  if (result.failure === "OUTPUT_TOO_LARGE" && options.tolerateOverflow !== true) {
    throw new ShellDiffLimitError("GIT_OUTPUT");
  }

  return result;
}

function chargeContent(context: GitShellContext, bytes: number): void {
  if (!context.meter.chargeContent(bytes)) throw new ShellDiffLimitError("CONTENT_BYTES");
}

/** Dirty paths from `status --porcelain=v1 -z`; renames contribute both paths. */
function parsePorcelainPaths(output: string): readonly string[] {
  const fields = output.split("\0");
  const paths = new Set<string>();

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? "";

    if (field.length < 4) continue;

    paths.add(field.slice(3));

    const code = field.slice(0, 2);

    if (!code.includes("R") && !code.includes("C")) continue;

    const origin = fields[index + 1];

    if (origin !== undefined && origin !== "") paths.add(origin);

    index += 1;
  }

  return [...paths].sort();
}

function statFingerprint(
  files: CaptureFileReader,
  absolute: string,
): Pick<SnapshotEntry, "state" | "fingerprint"> {
  const stat = files.stat(absolute);

  if (stat === null) return { state: "ABSENT", fingerprint: null };

  return { state: "PRESENT", fingerprint: `${stat.size}:${stat.mtimeMs}` };
}

/** Paths the index records as symlinks, from `ls-files --stage -z`. */
function indexedSymlinks(output: string): ReadonlySet<string> {
  const links = new Set<string>();

  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");

    if (tab !== -1 && record.startsWith(`${SYMLINK_MODE} `)) links.add(record.slice(tab + 1));
  }

  return links;
}

function snapshotEntries(
  paths: readonly string[],
  toplevel: string,
  symlinks: ReadonlySet<string>,
  context: GitShellContext,
): readonly SnapshotEntry[] | null {
  const entries: SnapshotEntry[] = [];
  const toHash: { index: number; absolute: string }[] = [];

  for (const gitPath of paths) {
    if (context.budget.expired()) throw new ShellDiffLimitError("TOTAL_TIME");

    const absolute = resolve(toplevel, gitPath);
    const repoPath = context.resolveRepoPath(absolute, toplevel);
    const access =
      repoPath === null || !isReadablePath(repoPath) || symlinks.has(gitPath)
        ? null
        : guardPath(context.files, context.projectRoot, absolute);

    if (repoPath === null || access === null || access.kind === "BLOCKED") {
      const kind = repoPath === null ? "OUTSIDE" : "BLOCKED";

      entries.push({ gitPath, repoPath, kind, ...statFingerprint(context.files, absolute) });
      continue;
    }

    const stat = access.kind === "OK" ? access.stat : null;
    const base = { gitPath, repoPath, kind: "READABLE" } as const;

    if (stat === null) {
      entries.push({ ...base, state: "ABSENT", fingerprint: null });
    } else if (!stat.isFile || stat.size > MAX_CAPTURED_FILE_BYTES) {
      entries.push({ ...base, state: "PRESENT", fingerprint: `${stat.size}:${stat.mtimeMs}` });
    } else {
      chargeContent(context, stat.size);
      toHash.push({ index: entries.length, absolute });
      entries.push({ ...base, state: "PRESENT", fingerprint: null });
    }
  }

  if (toHash.length === 0) return entries;

  const hashed = runBounded(context, ["hash-object", "--stdin-paths"], toplevel, {
    input: `${toHash.map((item) => item.absolute).join("\n")}\n`,
  });

  if (!hashed.ok) return null;

  const blobs = text(hashed.stdout)
    .split("\n")
    .filter((line) => line !== "");

  if (blobs.length !== toHash.length) return null;

  toHash.forEach((item, position) => {
    const entry = entries[item.index];
    const blob = blobs[position];

    if (entry !== undefined && blob !== undefined) {
      entries[item.index] = { ...entry, fingerprint: blob };
    }
  });

  return entries;
}

function captureSnapshot(context: GitShellContext, cwd: string): GitSnapshot | null {
  const top = runBounded(context, ["rev-parse", "--show-toplevel"], context.projectRoot);
  const cwdTop = runBounded(context, ["rev-parse", "--show-toplevel"], cwd);

  if (!top.ok || !cwdTop.ok) return null;

  const toplevel = resolve(text(top.stdout).trim());

  if (resolve(text(cwdTop.stdout).trim()) !== toplevel) return null;

  const headResult = runBounded(context, ["rev-parse", "-q", "--verify", "HEAD"], toplevel);

  if (!headResult.ok && headResult.failure !== "EXIT") return null;

  const index = runBounded(context, ["ls-files", "--stage", "-z"], toplevel);
  const status = runBounded(context, STATUS_ARGS, toplevel);

  if (!index.ok || !status.ok) return null;

  const dirtyPaths = parsePorcelainPaths(text(status.stdout));

  if (dirtyPaths.length > context.limits.maxStatusEntries) {
    throw new ShellDiffLimitError("STATUS_ENTRIES");
  }

  const entries = snapshotEntries(
    dirtyPaths,
    toplevel,
    indexedSymlinks(text(index.stdout)),
    context,
  );

  if (entries === null) return null;

  return {
    toplevel,
    head: headResult.ok ? text(headResult.stdout).trim() : null,
    indexDigest: sha256Hex(index.stdout),
    entries,
  };
}

/**
 * Read-only picture of HEAD, the index and every dirty path of the repository around
 * `cwd`. A path is classified by the evidence policy before anything is read; blocked
 * paths are compared by size and mtime only. Never writes a Git object. A `FAILED`
 * result is no proof: it names the exceeded limit, or is `UNPROVEN` when the picture
 * could not be taken for any other reason.
 */
export function takeGitSnapshot(context: GitShellContext, cwd: string): SnapshotResult {
  try {
    const snapshot = captureSnapshot(context, cwd);

    return snapshot === null
      ? { status: "FAILED", failure: { kind: "UNPROVEN" } }
      : { status: "TAKEN", snapshot };
  } catch (error) {
    return {
      status: "FAILED",
      failure:
        error instanceof ShellDiffLimitError
          ? { kind: "LIMIT_EXCEEDED", limit: error.limit }
          : { kind: "UNPROVEN" },
    };
  }
}

function readIndexImage(
  context: GitShellContext,
  toplevel: string,
  gitPath: string,
): ImageReading | null {
  if (!context.meter.chargeIndexRead()) throw new ShellDiffLimitError("INDEX_READS");

  const spec = `:${gitPath}`;
  const exists = runBounded(context, ["cat-file", "-e", spec], toplevel);

  if (!exists.ok) {
    return exists.failure === "EXIT" ? { kind: "IMAGE", image: { state: "ABSENT" } } : null;
  }

  if (!context.meter.chargeIndexRead()) throw new ShellDiffLimitError("INDEX_READS");

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

function changedEntries(pre: GitSnapshot, post: GitSnapshot) {
  const before = new Map(pre.entries.map((entry) => [entry.gitPath, entry]));
  const after = new Map(post.entries.map((entry) => [entry.gitPath, entry]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed: { entry: SnapshotEntry; wasDirty: boolean }[] = [];

  for (const key of keys) {
    const was = before.get(key);
    const now = after.get(key);
    const same =
      was !== undefined &&
      now !== undefined &&
      was.state === now.state &&
      was.fingerprint === now.fingerprint;
    const entry = now ?? was;

    if (!same && entry !== undefined) changed.push({ entry, wasDirty: was !== undefined });
  }

  return changed;
}

const UNPROVEN: GitDiffResult = { status: "FAILED", failure: { kind: "UNPROVEN" } };

function statOrNull(files: CaptureFileReader, absolute: string) {
  try {
    return files.stat(absolute);
  } catch {
    return null;
  }
}

function chargePostRead(context: GitShellContext, absolute: string): void {
  const stat = statOrNull(context.files, absolute);

  if (stat?.isFile && stat.size <= MAX_CAPTURED_FILE_BYTES) {
    chargeContent(context, stat.size);
  }
}

/**
 * Net Git-visible change between two snapshots. HEAD, index or top-level drift, and a
 * change outside the project root, make the diff `FAILED`. Each changed readable path
 * is read once for its post digest; a `CLEAN` one also gets its index image through
 * `cat-file --filters`, so it matches the worktree's line endings. Reads are charged
 * to the context's meter before they happen; an exceeded limit makes the diff `FAILED`
 * with that limit, never partial.
 */
export function diffGitSnapshots(
  context: GitShellContext,
  pre: GitSnapshot,
  post: GitSnapshot,
): GitDiffResult {
  const drifted =
    pre.toplevel !== post.toplevel ||
    pre.head !== post.head ||
    pre.indexDigest !== post.indexDigest;

  if (drifted) return UNPROVEN;

  const changes: GitShellChange[] = [];
  const problems = new Set<CaptureProblem>();

  try {
    for (const { entry, wasDirty } of changedEntries(pre, post)) {
      if (context.budget.expired()) throw new ShellDiffLimitError("TOTAL_TIME");
      if (entry.repoPath === null) return UNPROVEN;

      if (entry.kind === "BLOCKED") {
        changes.push({ path: entry.repoPath, preState: "UNREAD" });
        continue;
      }

      const absolute = resolve(post.toplevel, entry.gitPath);

      chargePostRead(context, absolute);

      const after = readFileImage(context.files, context.projectRoot, absolute);

      if (after.kind === "PROBLEM") {
        problems.add(after.problem);
        continue;
      }

      const postImage =
        after.image.state === "ABSENT"
          ? ({ state: "ABSENT" } as const)
          : ({ state: "PRESENT", digest: after.image.digest } as const);

      if (wasDirty) {
        changes.push({ path: entry.repoPath, preState: "DIRTY", post: postImage });
        continue;
      }

      const indexImage = readIndexImage(context, post.toplevel, entry.gitPath);

      if (indexImage === null) return UNPROVEN;
      if (indexImage.kind === "PROBLEM") {
        problems.add(indexImage.problem);
        continue;
      }

      changes.push({
        path: entry.repoPath,
        preState: "CLEAN",
        indexImage: indexImage.image,
        post: postImage,
      });
    }
  } catch (error) {
    return error instanceof ShellDiffLimitError
      ? { status: "FAILED", failure: { kind: "LIMIT_EXCEEDED", limit: error.limit } }
      : UNPROVEN;
  }

  return { status: "AVAILABLE", changes, problems: [...problems] };
}
