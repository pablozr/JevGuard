import { mkdirSync, writeFileSync } from "node:fs";
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

let supportDirectory: string | undefined;

function support(): string {
  if (supportDirectory === undefined) {
    const directory = join(tmpdir(), `jevguard-git-hermetic-${process.pid}`);

    mkdirSync(join(directory, "hooks"), { recursive: true });
    writeFileSync(join(directory, "gitconfig"), "");
    supportDirectory = directory;
  }

  return supportDirectory;
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
