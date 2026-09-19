import { normalizePath } from "./paths";

/**
 * Matches a changed path against a rule scope glob. Both Windows and POSIX
 * separators are normalized; `*`, `**`, and `?` are supported.
 */
export function matchesScope(path: string, scope: string): boolean {
  return globToRegExp(scope).test(normalizePath(path));
}

function globToRegExp(glob: string): RegExp {
  const source = glob.replace(/\\/g, "/");
  let pattern = "";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";

    if (char === "*") {
      if (source[index + 1] === "*") {
        const followedBySlash = source[index + 2] === "/";

        pattern += followedBySlash ? "(?:.*/)?" : ".*";
        index += followedBySlash ? 2 : 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      pattern += "[^/]";
      continue;
    }

    pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  return new RegExp(`^${pattern}$`);
}
