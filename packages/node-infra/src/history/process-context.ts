import { homedir } from "node:os";
import type { HistoryEnvironment, ReviewHistoryPathContext } from "./types";

/** Process-backed history path context: cwd, environment, and home directory. */
export function createProcessReviewHistoryContext(): ReviewHistoryPathContext {
  return {
    cwd: process.cwd(),
    environment: processEnvironment(),
    homedir: homedir(),
  };
}

function processEnvironment(): HistoryEnvironment {
  return {
    get(name: string): string | undefined {
      return process.env[name];
    },
  };
}
