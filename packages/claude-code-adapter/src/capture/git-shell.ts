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
import type {
  CaptureFileReader,
  GitDiffResult,
  GitShellContext,
  GitSnapshot,
  ImageReading,
  SnapshotEntry,
} from "./types";

const MAX_STATUS_ENTRIES = 5000;
const MAX_CAT_FILE_CALLS = 400;
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
    if (context.budget.expired()) return null;

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
      toHash.push({ index: entries.length, absolute });
      entries.push({ ...base, state: "PRESENT", fingerprint: null });
    }
  }

  if (toHash.length === 0) return entries;

  const hashed = context.git(
    ["hash-object", "--stdin-paths"],
    toplevel,
    `${toHash.map((item) => item.absolute).join("\n")}\n`,
  );
  const blobs = text(hashed.stdout)
    .split("\n")
    .filter((line) => line !== "");

  if (!hashed.ok || blobs.length !== toHash.length) return null;

  toHash.forEach((item, position) => {
    const entry = entries[item.index];
    const blob = blobs[position];

    if (entry !== undefined && blob !== undefined) {
      entries[item.index] = { ...entry, fingerprint: blob };
    }
  });

  return entries;
}

/**
 * Read-only picture of HEAD, the index and every dirty path of the repository around
 * `cwd`. A path is classified by the evidence policy before anything is read; blocked
 * paths are compared by size and mtime only. Never writes a Git object. `null` means
 * the picture could not be taken, which the caller must treat as no proof.
 */
export function takeGitSnapshot(context: GitShellContext, cwd: string): GitSnapshot | null {
  try {
    if (context.budget.expired()) return null;

    const top = context.git(["rev-parse", "--show-toplevel"], context.projectRoot);
    const cwdTop = context.git(["rev-parse", "--show-toplevel"], cwd);

    if (!top.ok || !cwdTop.ok) return null;

    const toplevel = resolve(text(top.stdout).trim());

    if (resolve(text(cwdTop.stdout).trim()) !== toplevel) return null;

    const headResult = context.git(["rev-parse", "-q", "--verify", "HEAD"], toplevel);
    const index = context.git(["ls-files", "--stage", "-z"], toplevel);
    const status = context.git(STATUS_ARGS, toplevel);

    if (!index.ok || !status.ok) return null;

    const dirtyPaths = parsePorcelainPaths(text(status.stdout));

    if (dirtyPaths.length > MAX_STATUS_ENTRIES) return null;

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
  } catch {
    return null;
  }
}

function readIndexImage(
  context: GitShellContext,
  toplevel: string,
  gitPath: string,
  spend: () => boolean,
): ImageReading | null {
  if (!spend()) return null;

  const spec = `:${gitPath}`;

  if (!context.git(["cat-file", "-e", spec], toplevel).ok) {
    return { kind: "IMAGE", image: { state: "ABSENT" } };
  }

  if (!spend()) return null;

  const filtered = context.git(["cat-file", "--filters", spec], toplevel);

  if (!filtered.ok) return { kind: "PROBLEM", problem: "CAPTURE_FAILED" };

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

const FAILED: GitDiffResult = { diff: { status: "FAILED" }, problems: [] };

/**
 * Net Git-visible change between two snapshots. HEAD, index or top-level drift, and a
 * change outside the project root, make the diff `FAILED`. Each changed readable path
 * is read once for its post digest; a `CLEAN` one also gets its index image through
 * `cat-file --filters`, so it matches the worktree's line endings.
 */
export function diffGitSnapshots(
  context: GitShellContext,
  pre: GitSnapshot,
  post: GitSnapshot,
): GitDiffResult {
  if (pre.toplevel !== post.toplevel || pre.head !== post.head) return FAILED;
  if (pre.indexDigest !== post.indexDigest) return FAILED;

  const changes: GitShellChange[] = [];
  const problems = new Set<CaptureProblem>();
  let catFileCalls = 0;
  const spend = (): boolean => {
    catFileCalls += 1;

    return catFileCalls <= MAX_CAT_FILE_CALLS;
  };

  try {
    for (const { entry, wasDirty } of changedEntries(pre, post)) {
      if (context.budget.expired() || entry.repoPath === null) return FAILED;

      if (entry.kind === "BLOCKED") {
        changes.push({ path: entry.repoPath, preState: "UNREAD" });
        continue;
      }

      const after = readFileImage(
        context.files,
        context.projectRoot,
        resolve(post.toplevel, entry.gitPath),
      );

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

      const indexImage = readIndexImage(context, post.toplevel, entry.gitPath, spend);

      if (indexImage === null) return FAILED;
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
  } catch {
    return FAILED;
  }

  return { diff: { status: "AVAILABLE", changes }, problems: [...problems] };
}
