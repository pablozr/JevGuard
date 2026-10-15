import { isAbsolute, join } from "node:path";
import type { ReviewHistoryPathContext } from "./types";

const DATA_DIRECTORY = "jevguard";

/**
 * Resolves the JevGuard data directory: `jevguard` under an absolute `XDG_DATA_HOME`,
 * or under `~/.local/share` when it is unset, empty, or relative.
 */
export function resolveJevGuardDataDirectory(context: ReviewHistoryPathContext): string {
  const configured = context.environment.get("XDG_DATA_HOME");

  if (configured !== undefined && configured !== "" && isAbsolute(configured)) {
    return join(configured, DATA_DIRECTORY);
  }

  return join(context.homedir, ".local", "share", DATA_DIRECTORY);
}
