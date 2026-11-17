import { isAbsolute, relative, resolve } from "node:path";
import { guardPath, isReadablePath, MAX_CAPTURED_FILE_BYTES, sha256Hex } from "./file-image";
import { assertStatusEntries, chargeContent, runBounded, text } from "./git-run";
import { ShellDiffLimitError } from "./shell-diff-limits";
import type {
  CaptureFileReader,
  FileStat,
  GitShellContext,
  ObservedPath,
  SnapshotEntry,
  SnapshotResult,
  TakenSnapshot,
} from "./types";

const LINK_MODES = ["120000 ", "160000 "];

const STATUS_ARGS = [
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
];

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

function statKey(stat: FileStat): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
}

function statFingerprint(
  files: CaptureFileReader,
  absolute: string,
): Pick<SnapshotEntry, "state" | "fingerprint"> {
  const stat = files.stat(absolute);

  if (stat === null) return { state: "ABSENT", fingerprint: null };

  return { state: "PRESENT", fingerprint: statKey(stat) };
}

/** Paths the index records as symlinks or gitlinks, from `ls-files --stage -z`. */
function indexedLinks(output: string): readonly string[] {
  const links: string[] = [];

  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");

    if (tab !== -1 && LINK_MODES.some((mode) => record.startsWith(mode))) {
      links.push(record.slice(tab + 1));
    }
  }

  return links.sort();
}

/**
 * Observes one path after classifying it by the evidence policy. A path outside the
 * project root, blocked, or linked in the index is compared by `stat` metadata only and
 * never read. A readable regular file within the size limit is read once, charged to the
 * meter before the read, and fingerprinted by the sha256 of its raw bytes; one that
 * cannot be kept carries a `problem` and is not read.
 */
export function observePath(
  context: GitShellContext,
  toplevel: string,
  gitPath: string,
  links: ReadonlySet<string>,
): ObservedPath {
  const absolute = resolve(toplevel, gitPath);
  const repoPath = context.resolveRepoPath(absolute, toplevel);
  const access =
    repoPath === null || !isReadablePath(repoPath) || links.has(gitPath)
      ? null
      : guardPath(context.files, context.projectRoot, absolute);

  if (repoPath === null || access === null || access.kind === "BLOCKED") {
    const kind = repoPath === null ? "OUTSIDE" : "BLOCKED";

    return {
      entry: { gitPath, repoPath, kind, ...statFingerprint(context.files, absolute) },
      bytes: null,
    };
  }

  const base = { gitPath, repoPath, kind: "READABLE" } as const;
  const stat = access.kind === "OK" ? access.stat : null;

  if (stat === null) {
    return { entry: { ...base, state: "ABSENT", fingerprint: null }, bytes: null };
  }

  const unread = {
    ...base,
    state: "PRESENT",
    fingerprint: statKey(stat),
  } as const;

  if (!stat.isFile) return { entry: { ...unread, problem: "CONTENT_NOT_TEXT" }, bytes: null };
  if (stat.size > MAX_CAPTURED_FILE_BYTES) {
    return { entry: { ...unread, problem: "CONTENT_TOO_LARGE" }, bytes: null };
  }

  chargeContent(context, stat.size);

  const bytes = context.files.readBytes(absolute, MAX_CAPTURED_FILE_BYTES + 1);

  return { entry: { ...base, state: "PRESENT", fingerprint: sha256Hex(bytes) }, bytes };
}

function snapshotEntries(
  paths: readonly string[],
  toplevel: string,
  links: ReadonlySet<string>,
  context: GitShellContext,
): Pick<TakenSnapshot, "contents"> & { readonly entries: readonly SnapshotEntry[] } {
  const entries: SnapshotEntry[] = [];
  const contents = new Map<string, Uint8Array>();

  for (const gitPath of paths) {
    if (context.budget.expired()) throw new ShellDiffLimitError("TOTAL_TIME");

    const { entry, bytes } = observePath(context, toplevel, gitPath, links);

    entries.push(entry);

    if (bytes !== null) contents.set(gitPath, bytes);
  }

  return { entries, contents };
}

/**
 * Where the call was made, relative to the unit's repository: `INSIDE` when its `cwd` is
 * in no work tree or in the unit's own (a call from the agent's folder is fenced where the
 * unit is judged, ADR 0018), `FOREIGN` when it is in another one.
 */
type CallPlace = "INSIDE" | "FOREIGN";

/** Whether `path` is `root` itself or below it, after links and short names are expanded. */
function isWithin(context: GitShellContext, root: string, path: string): boolean {
  const inside = relative(resolve(root), context.files.realPath(path) ?? path);

  return inside === "" || (!isAbsolute(inside) && !inside.startsWith(".."));
}

/**
 * A `cwd` in no work tree leaves no proof of where the call ran when it is inside the
 * unit's repository: a `rev-parse` that fails there (a nested repository of another owner,
 * a `safe.directory` refusal) would otherwise fence a call whose writes nothing observed.
 * From outside the repository — the agent's own folder — the same failure is expected and
 * the call is fenced where the unit is judged (ADR 0018).
 */
function placeOf(context: GitShellContext, cwd: string, toplevel: string): CallPlace | null {
  const cwdTop = runBounded(context, ["rev-parse", "--show-toplevel"], cwd);

  if (!cwdTop.ok) return isWithin(context, toplevel, cwd) ? null : "INSIDE";

  return resolve(text(cwdTop.stdout).trim()) === toplevel ? "INSIDE" : "FOREIGN";
}

function captureSnapshot(
  context: GitShellContext,
  cwd: string,
): { readonly taken: TakenSnapshot; readonly place: CallPlace } | null {
  const top = runBounded(context, ["rev-parse", "--show-toplevel"], context.projectRoot);

  if (!top.ok) return null;

  const toplevel = resolve(text(top.stdout).trim());
  const place = placeOf(context, cwd, toplevel);

  if (place === null) return null;

  const headResult = runBounded(context, ["rev-parse", "-q", "--verify", "HEAD"], toplevel);

  if (!headResult.ok && headResult.failure !== "EXIT") return null;

  const index = runBounded(context, ["ls-files", "--stage", "-z"], toplevel);
  const status = runBounded(context, STATUS_ARGS, toplevel);

  if (!index.ok || !status.ok) return null;

  const dirtyPaths = parsePorcelainPaths(text(status.stdout));

  assertStatusEntries(context, dirtyPaths.length);

  const indexLinks = indexedLinks(text(index.stdout));
  const { entries, contents } = snapshotEntries(dirtyPaths, toplevel, new Set(indexLinks), context);

  return {
    taken: {
      snapshot: {
        toplevel,
        head: headResult.ok ? text(headResult.stdout).trim() : null,
        indexLinks,
        entries,
      },
      contents,
    },
    place,
  };
}

/**
 * Read-only picture of HEAD, the index links and every dirty path of the repository
 * around `cwd`, with the bytes of each readable dirty file. A path is classified by the
 * evidence policy before anything is read; blocked paths are compared by size and mtime
 * only. Never writes a Git object. A `FAILED` result is no proof: it names the exceeded
 * limit, or is `UNPROVEN` when the picture could not be taken for any other reason.
 */
export function takeGitSnapshot(context: GitShellContext, cwd: string): SnapshotResult {
  try {
    const captured = captureSnapshot(context, cwd);

    if (captured === null) return { status: "FAILED", failure: { kind: "UNPROVEN" } };

    const { taken, place } = captured;

    return place === "FOREIGN"
      ? { status: "TAKEN", ...taken, foreign: true }
      : { status: "TAKEN", ...taken };
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
