import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { WorkerSpawnResult } from "./types";

const WORKER_ENTRY_NAME = "worker.js";

export interface SpawnWorkerPorts {
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly exists: (path: string) => boolean;
}

const NODE_PORTS: SpawnWorkerPorts = { spawn, exists: existsSync };

/**
 * Starts the review worker as a detached, silent process next to the hook entrypoint
 * and returns without waiting. Throws when the entrypoint is not an absolute path or
 * the process cannot be created; a missing worker file is reported, never spawned.
 */
export function spawnDetachedWorker(
  hookEntry: string | undefined,
  environment: NodeJS.ProcessEnv,
  ports: SpawnWorkerPorts = NODE_PORTS,
): WorkerSpawnResult {
  if (hookEntry === undefined || !isAbsolute(hookEntry)) {
    throw new Error("the hook entrypoint is not an absolute path");
  }

  const workerEntry = join(dirname(hookEntry), WORKER_ENTRY_NAME);

  if (!ports.exists(workerEntry)) return "ENTRY_MISSING";

  const child = ports.spawn(process.execPath, [workerEntry], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: environment,
  });

  child.on("error", () => undefined);
  child.unref();

  return "STARTED";
}
