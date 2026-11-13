import { describe, expect, test } from "vitest";
import { createNodeProcessRunner } from "../src";

const SLEEP_SCRIPT = `${import.meta.dirname.replaceAll("\\", "/")}/support/sleep.mjs`;

describe("createNodeProcessRunner", () => {
  const runner = createNodeProcessRunner();

  test("runs a command and returns its exit code and stdout", async () => {
    const result = await runner.run({ command: "node", args: ["--version"], timeoutMs: 20_000 });

    expect(result).toMatchObject({ kind: "EXITED", exitCode: 0 });
    expect(result.kind === "EXITED" && result.stdout).toMatch(/^v\d+\./);
  });

  test("reports a missing command", async () => {
    const result = await runner.run({
      command: "jevguard-command-that-does-not-exist",
      args: ["--version"],
      timeoutMs: 20_000,
    });

    expect(result).toEqual({ kind: "NOT_FOUND" });
  });

  test.each([["has space"], ["a&b"], ["$(x)"], ["a;b"], [""]])(
    "rejects the argument %j before spawning",
    async (argument) => {
      const result = await runner.run({ command: "node", args: [argument], timeoutMs: 1_000 });

      expect(result).toEqual({ kind: "REJECTED_ARGUMENT" });
    },
  );

  test("rejects an unsafe command", async () => {
    const result = await runner.run({ command: "node && x", args: [], timeoutMs: 1_000 });

    expect(result).toEqual({ kind: "REJECTED_ARGUMENT" });
  });

  test("times out a slow command", async () => {
    const result = await runner.run({ command: "node", args: [SLEEP_SCRIPT], timeoutMs: 300 });

    expect(result).toEqual({ kind: "TIMED_OUT" });
  });
});
