import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolves the project root as the first ancestor of `cwd` (inclusive) that holds a
 * `.git` entry, file or directory. Without one, `cwd` is the root.
 */
export function resolveProjectRoot(
  cwd: string,
  hasGitMarker: (directory: string) => boolean = nodeHasGitMarker,
): string {
  let current = cwd;

  while (true) {
    if (hasGitMarker(current)) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return cwd;
    }

    current = parent;
  }
}

function nodeHasGitMarker(directory: string): boolean {
  return existsSync(join(directory, ".git"));
}
