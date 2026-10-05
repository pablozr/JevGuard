import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import type { CaptureFileReader, GitRunner, HookEnvironment, RemovePath } from "./types";

const GIT_TIMEOUT_MS = 4000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;

  return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function readAtMost(path: string, maxBytes: number): Uint8Array {
  const descriptor = openSync(path, "r");

  try {
    const buffer = Buffer.alloc(maxBytes);
    let length = 0;

    while (length < maxBytes) {
      const read = readSync(descriptor, buffer, length, maxBytes - length, length);

      if (read === 0) break;

      length += read;
    }

    return buffer.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

export function createNodeFileReader(): CaptureFileReader {
  return {
    stat(path) {
      try {
        const stats = lstatSync(path);

        return {
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          isFile: stats.isFile(),
          isLink: stats.isSymbolicLink(),
        };
      } catch (error) {
        if (isMissingPathError(error)) return null;

        throw error;
      }
    },
    realPath(path) {
      try {
        return realpathSync.native(path);
      } catch (error) {
        if (isMissingPathError(error)) return null;

        throw error;
      }
    },
    readBytes: readAtMost,
  };
}

export const removeTree: RemovePath = (path) => {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
};

export const runGit: GitRunner = (args, cwd, input) => {
  const result = spawnSync("git", [...args], {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_MAX_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "ignore"],
    ...(input === undefined ? {} : { input }),
  });

  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, stdout: new Uint8Array() };
  }

  return { ok: true, stdout: result.stdout };
};

export function createProcessEnvironment(env: NodeJS.ProcessEnv): HookEnvironment {
  return { get: (name) => env[name] };
}
