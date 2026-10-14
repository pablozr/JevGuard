import { ORPHAN_TTL_MS } from "../capture/unit-state";
import type { WorkerFileSystem } from "./types";

/** Names directly inside `directory`; empty when it cannot be listed. */
export function namesIn(files: WorkerFileSystem, directory: string): readonly string[] {
  try {
    return files.list(directory);
  } catch {
    return [];
  }
}

/** `true` when the file was last modified more than the orphan TTL before `nowMs`. */
export function isExpired(files: WorkerFileSystem, path: string, nowMs: number): boolean {
  const modifiedMs = files.modifiedMs(path);

  return modifiedMs !== null && nowMs - modifiedMs > ORPHAN_TTL_MS;
}
