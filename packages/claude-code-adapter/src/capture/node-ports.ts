import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { DEFAULT_SHELL_DIFF_LIMITS } from "./shell-diff-limits";
import type {
  CaptureFileReader,
  GitRunner,
  GitRunResult,
  HookEnvironment,
  RemovePath,
} from "./types";

function errorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;

  return error.code;
}

export function isMissingPathError(error: unknown): boolean {
  const code = errorCode(error);

  return code === "ENOENT" || code === "ENOTDIR";
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
          ctimeMs: stats.ctimeMs,
          ino: stats.ino,
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

interface SpawnOutcome {
  readonly error?: object | undefined;
  readonly status: number | null;
  readonly stdout: Uint8Array;
}

export function classifySpawnResult(result: SpawnOutcome): GitRunResult {
  if (result.error !== undefined) {
    const code = errorCode(result.error);

    if (code === "ETIMEDOUT") return { ok: false, failure: "TIMEOUT" };

    return { ok: false, failure: code === "ENOBUFS" ? "OUTPUT_TOO_LARGE" : "SPAWN" };
  }

  if (result.status === null) return { ok: false, failure: "SPAWN" };
  if (result.status !== 0) return { ok: false, failure: "EXIT" };

  return { ok: true, stdout: result.stdout };
}

export const runGit: GitRunner = (args, cwd, options = {}) => {
  const result = spawnSync("git", [...args], {
    cwd,
    timeout: options.timeoutMs ?? DEFAULT_SHELL_DIFF_LIMITS.gitCallTimeoutMs,
    windowsHide: true,
    maxBuffer: options.maxOutputBytes ?? DEFAULT_SHELL_DIFF_LIMITS.maxGitOutputBytes,
    stdio: ["pipe", "pipe", "ignore"],
    ...(options.input === undefined ? {} : { input: options.input }),
  });

  return classifySpawnResult(result);
};

export function createProcessEnvironment(env: NodeJS.ProcessEnv): HookEnvironment {
  return { get: (name) => env[name] };
}
