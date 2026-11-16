import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { HookEvent } from "../hook-event";
import type { CaptureFileReader, GitRunner, ShellDiffLimits } from "./types";

/** What one event says about where the unit's change lives (ADR 0018). */
export type RootCandidate =
  /** A call or edit named a place inside this work tree. */
  | { readonly status: "PLACE"; readonly toplevel: string }
  /** A write-capable event named a place, and no work tree holds it. */
  | { readonly status: "NO_PLACE" }
  /** The event is not evidence of a place: a read, a prompt, a turn end. */
  | { readonly status: "NOT_EVIDENCE" };

export interface RootLookup {
  readonly files: CaptureFileReader;
  readonly git: GitRunner;
  readonly limits: ShellDiffLimits;
  /**
   * `CLAUDE_PROJECT_DIR`, used only for a project that is not a Git work tree at all: the
   * session's own directory still roots an edit made inside it, as before ADR 0018.
   */
  readonly fallbackRoot: string | null;
}

function isInside(root: string, path: string): boolean {
  const inside = relative(resolve(root), resolve(path));

  return inside !== "" && !isAbsolute(inside) && !inside.startsWith("..");
}

const MAX_ANCESTOR_STEPS = 40;

function stdout(result: { readonly ok: true; readonly stdout: Uint8Array }): string {
  return new TextDecoder().decode(result.stdout).trim();
}

/** The existing directory at or above `start`, so a file the call is about may not exist. */
function existingDirectory(files: CaptureFileReader, start: string): string | null {
  let current = start;

  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    try {
      const stat = files.stat(current);

      if (stat !== null && !stat.isFile) return files.realPath(current) ?? current;
    } catch {
      return null;
    }

    const parent = dirname(current);

    if (parent === current) return null;

    current = parent;
  }

  return null;
}

function toplevelOf(lookup: RootLookup, directory: string): string | null {
  const result = lookup.git(["rev-parse", "--show-toplevel"], directory, {
    timeoutMs: lookup.limits.gitCallTimeoutMs,
    maxOutputBytes: lookup.limits.maxGitOutputBytes,
  });

  if (!result.ok) return null;

  const toplevel = stdout(result);

  return toplevel === "" ? null : resolve(toplevel);
}

/** The absolute path an edit names, before it is resolved to a directory. */
function editedPath(event: HookEvent): string | null {
  if (!("tool" in event) || event.tool.category !== "EDIT") return null;

  const { filePath } = event.tool;

  return filePath === null ? null : resolve(event.cwd, filePath);
}

function isWriteCapableCall(event: HookEvent): boolean {
  if (!("tool" in event)) return false;

  switch (event.tool.category) {
    case "BASH":
    case "POWERSHELL":
    case "MCP":
      return true;
    case "EDIT":
      return event.tool.filePath !== null;
    default:
      return false;
  }
}

/**
 * The place this event points at, if it points at one. A shell or MCP call speaks for its
 * `cwd` only when that `cwd` is inside a work tree: on a host that runs the agent in its
 * own folder, that call says where the agent works, not where the change is (ADR 0018).
 */
export function rootCandidateOf(event: HookEvent, lookup: RootLookup): RootCandidate {
  const path = editedPath(event);

  if (path !== null) {
    const directory = existingDirectory(lookup.files, dirname(path));
    const toplevel = directory === null ? null : toplevelOf(lookup, directory);

    if (toplevel !== null) return { status: "PLACE", toplevel };

    const { fallbackRoot } = lookup;

    return fallbackRoot !== null && isInside(fallbackRoot, path)
      ? { status: "PLACE", toplevel: resolve(fallbackRoot) }
      : { status: "NO_PLACE" };
  }

  if (!isWriteCapableCall(event)) return { status: "NOT_EVIDENCE" };

  const toplevel = toplevelOf(lookup, event.cwd);

  return toplevel === null ? { status: "NO_PLACE" } : { status: "PLACE", toplevel };
}
