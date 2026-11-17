import { mkdirSync, rmSync } from "node:fs";
import { RUN_DIRECTORY_VARIABLE, runSupportDirectory } from "./hermetic-git";

/**
 * One temporary directory per run, holding the Git configuration of every worker.
 *
 * Vitest ends a worker by terminating its process, so a worker cannot remove what it
 * created: before this teardown, every run left one `jevguard-git-hermetic-<pid>`
 * directory per worker in the system temp directory (891 of them on this machine).
 * Making the directory here, before the workers are spawned, gives the run a single
 * owner with a teardown that always runs, and each worker still gets its own subtree
 * (`tools/test/hermetic-git.ts` names it after its process) under this path.
 *
 * The path goes out through the environment because workers inherit it in both pools;
 * the forks pool could also derive it from its parent, but the threads pool cannot.
 */
export default function setup(): () => void {
  const directory = runSupportDirectory(process.pid);

  mkdirSync(directory, { recursive: true });
  process.env[RUN_DIRECTORY_VARIABLE] = directory;

  return () => {
    delete process.env[RUN_DIRECTORY_VARIABLE];
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
}
