import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Git configuration a test process may inherit from the machine running the suite.
 *
 * A global `core.hooksPath` (husky, pre-commit, an agent runner) makes every fixture
 * `git commit` run that hook: measured at ~1.5 s per commit instead of ~100 ms on
 * Windows, which turns a green suite into a slow one and starves the worker's RPC
 * queue. Git reads command-line configuration from these variables, so a fixture
 * drops them and points the global and system files at an empty config instead.
 * Local repository configuration still applies: fixtures own their repositories.
 */
const INHERITED_CONFIG = /^GIT_CONFIG_(PARAMETERS|COUNT)$|^GIT_CONFIG_(KEY|VALUE)_\d+$/;

/**
 * The directory the whole run owns, named after the process that started it.
 *
 * The runner does not let a worker clean up after itself: Vitest's forks pool ends a
 * worker by terminating the process, so no `exit` handler runs there. A worker
 * therefore writes inside the run's directory (its parent process is the run) and the
 * run's teardown removes the tree.
 */
const RUN_DIRECTORY_PREFIX = "jevguard-git-hermetic-run";

export function runSupportDirectory(pid: number = process.ppid): string {
  return join(tmpdir(), `${RUN_DIRECTORY_PREFIX}-${pid}`);
}

let supportDirectory: string | undefined;

function support(): string {
  if (supportDirectory === undefined) {
    const directory = join(runSupportDirectory(), `worker-${process.pid}`);

    mkdirSync(join(directory, "hooks"), { recursive: true });
    writeFileSync(join(directory, "gitconfig"), "");
    supportDirectory = directory;

    // A helper used outside the suite (a script, a bench run) has no run teardown, so
    // it removes its own subtree when its process goes away. Inside the suite this
    // never fires: the worker is terminated, not exited.
    process.once("exit", removeSupportDirectory);
  }

  return supportDirectory;
}

/**
 * Removes the per-worker support directory, if one was created.
 *
 * Safe to call more than once: a worker that finished normally leaves nothing behind,
 * and so does one torn down early.
 */
export function removeSupportDirectory(): void {
  if (supportDirectory === undefined) return;

  try {
    rmSync(supportDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // This runs from a process exit handler: a file another process still holds (Windows
    // keeps temporary directories busy for a moment) must not fail a green run. The
    // directory is per worker and lives under the system temp directory either way.
  }

  supportDirectory = undefined;
}

/** An empty file Git reads as both the system and the global configuration. */
export function emptyGitConfigFile(): string {
  return join(support(), "gitconfig");
}

/** A directory with no hooks, given explicitly to a fixture command. */
export function emptyHooksDirectory(): string {
  return join(support(), "hooks");
}

/** `environment` without the Git configuration it would inherit, hooks off. */
export function hermeticGitEnv(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined && !INHERITED_CONFIG.test(name)) env[name] = value;
  }

  env.GIT_CONFIG_GLOBAL = emptyGitConfigFile();
  env.GIT_CONFIG_SYSTEM = emptyGitConfigFile();
  env.GIT_CONFIG_NOSYSTEM = "1";

  return env;
}

/** Makes the current process hermetic, so every Git child it spawns is too. */
export function installHermeticGitEnv(): void {
  for (const name of Object.keys(process.env)) {
    if (INHERITED_CONFIG.test(name)) delete process.env[name];
  }

  const env = hermeticGitEnv();

  process.env.GIT_CONFIG_GLOBAL = env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_SYSTEM = env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_NOSYSTEM = env.GIT_CONFIG_NOSYSTEM;
}
