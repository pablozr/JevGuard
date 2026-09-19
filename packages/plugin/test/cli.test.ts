import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { runCli } from "../src/cli/run-cli";
import type { CliDependencies, CliIO } from "../src/cli/types";
import type { LoginOutcome } from "@jevguard/opencode-adapter";

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

class StubLogin implements CliDependencies {
  calls = 0;
  outcome: LoginOutcome = { status: "SAVED" };

  login(): Promise<LoginOutcome> {
    this.calls += 1;
    return Promise.resolve(this.outcome);
  }
}

function harness(): { io: RecordingIO; dependencies: StubLogin } {
  return { io: new RecordingIO(), dependencies: new StubLogin() };
}

describe("runCli dispatch", () => {
  test("runs login and reports success for the login command", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(0);
    expect(dependencies.calls).toBe(1);
    expect(io.out.join("\n")).toContain("Credential saved");
    expect(io.err).toEqual([]);
  });

  test("prints usage and fails when no command is given", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli([], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.calls).toBe(0);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects an unknown command", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["logout"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.calls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
  });

  test("rejects extra arguments, including a secret-looking value", async () => {
    const { io, dependencies } = harness();

    const exitCode = await runCli(["login", "test-key"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(dependencies.calls).toBe(0);
    expect(io.err.join("\n")).toContain("Usage: jevguard login");
    expect(io.err.join("\n")).not.toContain("test-key");
  });

  test("reports an aborted prompt without a success message", async () => {
    const { io, dependencies } = harness();
    dependencies.outcome = { status: "ABORTED" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.out).toEqual([]);
    expect(io.err.join("\n")).toContain("Login cancelled");
  });

  test("reports a non-TTY login as an actionable failure", async () => {
    const { io, dependencies } = harness();
    dependencies.outcome = { status: "FAILED", reason: "NOT_A_TTY" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("interactive terminal");
  });

  test("reports a store failure without serializing a native error", async () => {
    const { io, dependencies } = harness();
    dependencies.outcome = { status: "FAILED", reason: "STORE_WRITE_FAILURE" };

    const exitCode = await runCli(["login"], io, dependencies);

    expect(exitCode).toBe(1);
    expect(io.err.join("\n")).toContain("OS credential store");
    expect(io.err.join("\n")).not.toContain("test-key");
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
