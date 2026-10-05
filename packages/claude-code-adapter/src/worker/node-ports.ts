import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { DIR_MODE } from "../capture/unit-state";
import type { ReviewDeadline, WorkerFileSystem } from "./types";

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

export function createNodeWorkerFileSystem(): WorkerFileSystem {
  return {
    list(directory) {
      try {
        return readdirSync(directory);
      } catch (error) {
        if (isMissing(error)) return [];

        throw error;
      }
    },
    read(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (error) {
        if (isMissing(error)) return null;

        throw error;
      }
    },
    modifiedMs(path) {
      try {
        return statSync(path).mtimeMs;
      } catch (error) {
        if (isMissing(error)) return null;

        throw error;
      }
    },
    rename(from, to) {
      try {
        renameSync(from, to);

        return "MOVED";
      } catch (error) {
        return isMissing(error) ? "LOST" : "FAILED";
      }
    },
    remove(path) {
      rmSync(path, { force: true, maxRetries: 5, retryDelay: 50 });
    },
    ensureDirectory(path) {
      mkdirSync(path, { recursive: true, mode: DIR_MODE });
    },
  };
}

export function createTimerDeadline(): ReviewDeadline {
  return {
    async race(work, milliseconds) {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const expired = new Promise<{ readonly status: "DEADLINE" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "DEADLINE" }), milliseconds);
      });

      try {
        return await Promise.race([
          work.then((value) => ({ status: "DONE" as const, value })),
          expired,
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
