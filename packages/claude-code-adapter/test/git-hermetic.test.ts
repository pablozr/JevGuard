import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { emptyGitConfigFile, hermeticGitEnv } from "../../../tools/test/hermetic-git";
import { gitOutput, initRepository } from "./hook-world";

/** The PowerShell-style quoting Git expects in `GIT_CONFIG_PARAMETERS`. */
function parametersFor(hooks: string): string {
  return `'core.hooksPath=${hooks.replaceAll("\\", "/")}'`;
}

function runGit(cwd: string, env: NodeJS.ProcessEnv, ...args: readonly string[]): void {
  execFileSync("git", [...args], { cwd, env, stdio: "ignore" });
}

/** A repository with one staged file, ready to commit. */
function stageRepository(root: string, env: NodeJS.ProcessEnv): void {
  mkdirSync(root, { recursive: true });
  runGit(root, env, "init", "-q");
  runGit(root, env, "config", "user.email", "test@example.com");
  runGit(root, env, "config", "user.name", "Test");
  writeFileSync(join(root, "a.ts"), "one\n");
  runGit(root, env, "add", ".");
}

describe("hermetic Git fixtures", () => {
  let base: string;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "jevguard-hermetic-git-")));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  /** A hook directory whose pre-commit leaves a marker file behind when it runs. */
  function plantHook(name: string): { readonly hooks: string; readonly marker: string } {
    const hooks = join(base, `hooks-${name}`);
    const marker = join(base, `ran-${name}`);

    mkdirSync(hooks);
    writeFileSync(
      join(hooks, "pre-commit"),
      `#!/bin/sh\ntouch "${marker.replaceAll("\\", "/")}"\n`,
      { mode: 0o755 },
    );

    return { hooks, marker };
  }

  test("the worker runs without the machine's Git configuration", () => {
    expect(process.env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(process.env.GIT_CONFIG_GLOBAL).toBe(emptyGitConfigFile());
    expect(
      execFileSync("git", ["config", "--global", "--list"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).toBe("");
  });

  test("hermeticGitEnv drops the configuration Git would inherit", () => {
    const planted = plantHook("inherited");
    const env = hermeticGitEnv({
      ...process.env,
      GIT_CONFIG_PARAMETERS: parametersFor(planted.hooks),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: planted.hooks,
    });

    expect(env).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
    expect(env).not.toHaveProperty("GIT_CONFIG_COUNT");
    expect(env).not.toHaveProperty("GIT_CONFIG_KEY_0");
    expect(env).not.toHaveProperty("GIT_CONFIG_VALUE_0");
    expect(env.GIT_CONFIG_GLOBAL).toBe(emptyGitConfigFile());
    expect(env.GIT_CONFIG_SYSTEM).toBe(emptyGitConfigFile());
    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });

  test("an inherited hook path runs a commit made with the inherited environment", () => {
    const planted = plantHook("control");
    const root = join(base, "control");
    const inherited = { ...process.env, GIT_CONFIG_PARAMETERS: parametersFor(planted.hooks) };

    stageRepository(root, inherited);
    runGit(root, inherited, "commit", "-q", "-m", "control");

    expect(existsSync(planted.marker)).toBe(true);
  });

  test("a commit through hermeticGitEnv ignores a hook configured where Git looks", () => {
    const planted = plantHook("global-config");
    const globalConfig = join(base, "gitconfig");
    const root = join(base, "hermetic");

    writeFileSync(globalConfig, `[core]\n\thooksPath = ${planted.hooks.replaceAll("\\", "/")}\n`);

    const env = hermeticGitEnv({ ...process.env, GIT_CONFIG_GLOBAL: globalConfig });

    stageRepository(root, env);
    runGit(root, env, "commit", "-q", "-m", "hermetic");

    expect(existsSync(planted.marker)).toBe(false);
    expect(gitOutput(root, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("a fixture commit never inherits a hook path left in the process", () => {
    const planted = plantHook("fixture");
    const root = join(base, "project");
    const previous = process.env.GIT_CONFIG_PARAMETERS;

    process.env.GIT_CONFIG_PARAMETERS = parametersFor(planted.hooks);

    try {
      initRepository(root);
    } finally {
      if (previous === undefined) delete process.env.GIT_CONFIG_PARAMETERS;
      else process.env.GIT_CONFIG_PARAMETERS = previous;
    }

    expect(existsSync(planted.marker)).toBe(false);
    expect(gitOutput(root, "rev-list", "--count", "HEAD")).toBe("1");
  });
});
