import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli/run-cli";
import type { CliDependencies, CliIO } from "../src/cli/types";
import type { InstallOutcome, InstallTarget, LoginOutcome } from "@jevguard/opencode-adapter";

const GLOBAL_PATH = "C:/home/.config/opencode/opencode.json";
const PROJECT_PATH = "C:/repo/opencode.json";
const MANUAL_SNIPPET = '{ "plugin": ["@pablozrrrr/jevguard"] }';

class RecordingIO implements CliIO {
  readonly out: string[] = [];
  readonly err: string[] = [];

  writeOut(message: string): void {
    this.out.push(message);
  }

  writeErr(message: string): void {
    this.err.push(message);
  }
}

class StubDependencies implements CliDependencies {
  loginCalls = 0;
  loginOutcome: LoginOutcome = { status: "SAVED" };
  installCalls = 0;
  readonly installTargets: InstallTarget[] = [];
  installOutcome: InstallOutcome = {
    status: "INSTALLED",
    target: "global",
    path: GLOBAL_PATH,
  };

  login(): Promise<LoginOutcome> {
    this.loginCalls += 1;
    return Promise.resolve(this.loginOutcome);
  }

  install(target: InstallTarget): Promise<InstallOutcome> {
    this.installCalls += 1;
    this.installTargets.push(target);
    return Promise.resolve(this.installOutcome);
  }
}

function harness(): { io: RecordingIO; dependencies: StubDependencies } {
  return { io: new RecordingIO(), dependencies: new StubDependencies() };
}

describe("runCli dispatch", () => {
  test("runs login and reports success for the login command", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.loginCalls).toBe(1);
    expect(io.out.join("\n")).toContain("Credential saved");
    expect(io.err).toEqual([]);
  });

  test("prints usage and fails when no command is given", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli([], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.loginCalls).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects an unknown command", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["logout"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.loginCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects extra arguments, including a secret-looking value", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["login", "test-key"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.loginCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
    expect(io.err.join("\n")).not.toContain("test-key");
  });

  test("reports an aborted prompt without a success message", async () => {
    const { io, dependencies } = harness();
    dependencies.loginOutcome = { status: "ABORTED" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Login cancelled");
  });

  test("reports a non-TTY login as an actionable failure", async () => {
    const { io, dependencies } = harness();
    dependencies.loginOutcome = { status: "FAILED", reason: "NOT_A_TTY" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("interactive terminal");
  });

  test("reports a store failure without serializing a native error", async () => {
    const { io, dependencies } = harness();
    dependencies.loginOutcome = { status: "FAILED", reason: "STORE_WRITE_FAILURE" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("OS credential store");
    expect(io.err.join("\n")).not.toContain("test-key");
  });

  test("dispatches install to the global target and reports success", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.installTargets).toEqual(["global"]);
    expect(io.out.join("\n")).toContain(GLOBAL_PATH);
    expect(io.err).toEqual([]);
  });

  test("dispatches install --project to the project target", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "INSTALLED",
      target: "project",
      path: PROJECT_PATH,
    };

    const exitCode = await runCli(["install", "--project"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.installTargets).toEqual(["project"]);
    expect(io.out.join("\n")).toContain(PROJECT_PATH);
  });

  test("reports an already-installed plugin as success without rewriting", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "ALREADY_INSTALLED",
      target: "global",
      path: GLOBAL_PATH,
    };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(io.out.join("\n")).toContain("already registered");
    expect(io.err).toEqual([]);
  });

  test("rejects install with an unknown flag without calling the dependency", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["install", "--other"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.installCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects install with an extra argument and never echoes it", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["install", "test-key"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.installCalls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
    expect(io.err.join("\n")).not.toContain("test-key");
  });

  test("reports an aborted install without a success message", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = { status: "ABORTED", target: "global", path: GLOBAL_PATH };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Install cancelled");
  });

  test("prints the manual snippet when the install cannot confirm off a TTY", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "NOT_A_TTY",
    };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain(MANUAL_SNIPPET);
  });

  test("prints the manual snippet when a JSONC config blocks the install", async () => {
    const { io, dependencies } = harness();
    dependencies.installOutcome = {
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "UNSUPPORTED_JSONC",
    };

    const exitCode = await runCli(["install"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain(MANUAL_SNIPPET);
  });
});

describe("package bin wiring", () => {
  test("declares the jevguard bin and ships its entry file", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { bin?: Record<string, string> };

    expect(manifest.bin?.jevguard).toBe("./src/cli/main.ts");
    expect(existsSync(new URL("../src/cli/main.ts", import.meta.url))).toBe(true);
  });

  test("runs the CLI entry file under the Bun runtime", () => {
    const entry = readFileSync(new URL("../src/cli/main.ts", import.meta.url), "utf8");

    expect(entry.startsWith("#!/usr/bin/env bun")).toBe(true);
  });
});
