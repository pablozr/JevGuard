import { isAbsolute, relative, resolve } from "node:path";

/** Built-in tools that write files; `apply_patch` is the host alias of `patch`. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multiedit",
  "patch",
  "apply_patch",
]);

const PATCH_FILE_HEADER = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

/**
 * Project-relative paths one tool call wrote, read from its input the way the host
 * does: `path`/`filePath` for write and edit tools, the `*** ... File:` headers of a
 * patch. A path outside the project root is kept as-is (absolute), so it never
 * matches the project diff and makes the turn incomplete. Non-write tools yield none.
 */
export function writtenPaths(tool: string, input: unknown, root: string): readonly string[] {
  if (!WRITE_TOOLS.has(tool.toLowerCase()) || !isRecord(input)) {
    return [];
  }

  const raw = [stringField(input, "path"), stringField(input, "filePath"), ...patchPaths(input)];

  return raw
    .filter((path): path is string => path !== null)
    .map((path) => toProjectPath(root, path));
}

function patchPaths(input: Record<string, unknown>): readonly string[] {
  const text = stringField(input, "patchText");

  if (text === null) {
    return [];
  }

  return [...text.matchAll(PATCH_FILE_HEADER)].map((match) => (match[1] ?? "").trim());
}

/** Normalizes to the `vcs.diff` form: relative to the root, forward slashes. */
function toProjectPath(root: string, path: string): string {
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  const fromRoot = relative(root, absolute);

  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    return absolute.replaceAll("\\", "/");
  }

  return fromRoot.replaceAll("\\", "/");
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const value = input[key];

  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
