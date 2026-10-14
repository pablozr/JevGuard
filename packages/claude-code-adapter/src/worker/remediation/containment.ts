import type { CaptureFileReader } from "../../capture/types";
import type { ProjectProbe } from "./types";

const SEPARATORS = /\\/g;
const TRAILING_SEPARATORS = /[\\/]+$/;
const GIT_MARKER = ".git";

function slashed(path: string): string {
  return path.replace(SEPARATORS, "/").replace(TRAILING_SEPARATORS, "");
}

/** `true` when `path` is `root` or lies under it; case and separators never matter. */
export function isInsidePath(path: string, root: string): boolean {
  const candidate = slashed(path).toLowerCase();
  const container = slashed(root).toLowerCase();

  return candidate === container || candidate.startsWith(`${container}/`);
}

/** The directory that holds `path`, or `null` at the top of the path. */
export function parentOf(path: string): string | null {
  const normalized = slashed(path);
  const cut = normalized.lastIndexOf("/");

  return cut <= 0 ? null : normalized.slice(0, cut);
}

function gitToplevelOf(start: string, probe: ProjectProbe): string | null {
  for (let directory: string | null = start; directory !== null; directory = parentOf(directory)) {
    if (probe.hasGitMarker(directory)) return directory;
  }

  return null;
}

/**
 * `true` when the canonical `path` lies inside the project root or inside the Git working
 * tree that contains it (the nearest ancestor with a `.git` file or directory). Nothing
 * private to the user may live there: a repository can be cloned, shared or committed.
 */
export function isInsideProject(path: string, projectRoot: string, probe: ProjectProbe): boolean {
  const realRoot = probe.realPath(projectRoot) ?? projectRoot;
  const toplevel = gitToplevelOf(realRoot, probe);
  const roots = toplevel === null ? [realRoot] : [realRoot, toplevel];

  return roots.some((root) => isInsidePath(path, root));
}

/** The canonical path of `path`, or of its nearest existing ancestor; `null` when none exists. */
export function realPathOfNearest(path: string, probe: ProjectProbe): string | null {
  for (let directory: string | null = path; directory !== null; directory = parentOf(directory)) {
    const real = probe.realPath(directory);

    if (real !== null) return real;
  }

  return null;
}

export function projectProbeOf(reader: CaptureFileReader): ProjectProbe {
  return {
    realPath: (path) => reader.realPath(path),
    hasGitMarker: (directory) => reader.stat(`${directory}/${GIT_MARKER}`) !== null,
  };
}
