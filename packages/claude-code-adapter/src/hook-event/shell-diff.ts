import type { JsonObject, ShellEditDiff } from "./types";

const PATH_KEYS = ["path", "file", "filePath", "file_path"] as const;
const INCOMPLETENESS_FLAGS = ["moreFiles", "unavailable", "skipped", "shared"] as const;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIncompleteFlag(container: JsonObject, key: string): boolean {
  if (!(key in container)) return false;

  const value = container[key];

  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (Array.isArray(value)) return value.length > 0;

  return true;
}

function entryPath(entry: unknown): string | null {
  if (typeof entry === "string") return entry === "" ? null : entry;
  if (!isJsonObject(entry)) return null;

  for (const key of PATH_KEYS) {
    const value = entry[key];

    if (typeof value === "string" && value !== "") return value;
  }

  return null;
}

/**
 * Reading of the host's `bashEditDiff`, kept only as a cross-check of the adapter's
 * Git diff; an absent field is not evidence of "no change".
 */
export function readShellEditDiff(toolResponse: unknown): ShellEditDiff {
  if (!isJsonObject(toolResponse)) return { status: "ABSENT" };

  const diff = toolResponse.bashEditDiff;

  if (diff === undefined || diff === null) return { status: "ABSENT" };
  if (!isJsonObject(diff)) return { status: "INCOMPLETE" };

  const changed = diff.changedFiles;

  if (!Array.isArray(changed)) return { status: "INCOMPLETE" };
  if (INCOMPLETENESS_FLAGS.some((flag) => isIncompleteFlag(diff, flag))) {
    return { status: "INCOMPLETE" };
  }

  const paths: string[] = [];

  for (const entry of changed) {
    const path = entryPath(entry);

    if (path === null) return { status: "INCOMPLETE" };

    paths.push(path);
  }

  return { status: "PRESENT", changedFiles: paths };
}
