import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createBudget, narrowBudget } from "../src/capture/budget";
import { classifySpawnResult } from "../src/capture/node-ports";
import { createShellDiffMeter, DEFAULT_SHELL_DIFF_LIMITS } from "../src/capture/shell-diff-limits";
import { decodeShellPreRecord, decodeStateLine } from "../src/capture/state-codec";
import { HookWorld, initRepository } from "./hook-world";

const STDOUT = new Uint8Array([1]);

describe("shell diff meter", () => {
  test("content is inclusive at the limit and fails one byte past it", () => {
    const meter = createShellDiffMeter({ ...DEFAULT_SHELL_DIFF_LIMITS, maxContentBytes: 10 });

    expect(meter.chargeContent(6)).toBe(true);
    expect(meter.chargeContent(4)).toBe(true);
    expect(meter.chargeContent(1)).toBe(false);
    expect(meter.chargeContent(0)).toBe(false);
  });

  test("index reads are inclusive at the limit and fail on the next one", () => {
    const meter = createShellDiffMeter({ ...DEFAULT_SHELL_DIFF_LIMITS, maxIndexReads: 2 });

    expect(meter.chargeIndexRead()).toBe(true);
    expect(meter.chargeIndexRead()).toBe(true);
    expect(meter.chargeIndexRead()).toBe(false);
  });

  test("each meter counts on its own", () => {
    const limits = { ...DEFAULT_SHELL_DIFF_LIMITS, maxContentBytes: 1 };

    expect(createShellDiffMeter(limits).chargeContent(1)).toBe(true);
    expect(createShellDiffMeter(limits).chargeContent(1)).toBe(true);
  });
});

describe("narrowBudget", () => {
  test("expires at its own deadline when the parent has more time", () => {
    let now = 0;
    const parent = createBudget(() => now, 10_000);
    const narrow = narrowBudget(parent, () => now, 100);

    expect(narrow.remainingMs()).toBe(100);

    now = 99;

    expect(narrow.expired()).toBe(false);

    now = 100;

    expect(narrow.expired()).toBe(true);
    expect(parent.expired()).toBe(false);
  });

  test("never outlives the parent", () => {
    let now = 0;
    const parent = createBudget(() => now, 50);
    const narrow = narrowBudget(parent, () => now, 100);

    expect(narrow.remainingMs()).toBe(50);

    now = 50;

    expect(narrow.expired()).toBe(true);
    expect(narrow.remainingMs()).toBe(0);
  });
});

describe("classifySpawnResult", () => {
  test.each([
    ["a timeout", { error: { code: "ETIMEDOUT" }, status: null, stdout: STDOUT }, "TIMEOUT"],
    [
      "a full buffer",
      { error: { code: "ENOBUFS" }, status: null, stdout: STDOUT },
      "OUTPUT_TOO_LARGE",
    ],
    ["a spawn failure", { error: { code: "ENOENT" }, status: null, stdout: STDOUT }, "SPAWN"],
    ["a non-zero exit", { status: 1, stdout: STDOUT }, "EXIT"],
    ["a process killed by a signal", { status: null, stdout: STDOUT }, "SPAWN"],
  ] as const)("%s", (_label, result, failure) => {
    expect(classifySpawnResult(result)).toEqual({ ok: false, failure });
  });

  test("a zero exit is ok", () => {
    expect(classifySpawnResult({ status: 0, stdout: STDOUT })).toEqual({
      ok: true,
      stdout: STDOUT,
    });
  });
});

describe("persisted shell diff failures", () => {
  let world: HookWorld;

  beforeEach(() => {
    world = new HookWorld();
    initRepository(world.projectRoot);
  });

  afterEach(() => {
    world.cleanup();
  });

  function recordedShellLine(): Record<string, unknown> {
    const id = world.nextToolId();
    const input = { command: "write" };

    world.prompt("rewrite with the shell");
    world.preTool("Bash", id, input);
    world.write("a.ts", "changed\n");
    world.postTool("Bash", id, input);

    const rows = readFileSync(join(world.unitDirectory(), "events.jsonl"), "utf8")
      .split("\n")
      .filter((row) => row !== "")
      .map((row) => JSON.parse(row));
    const line = rows.find((row) => row.capture?.gitDiff !== undefined);

    if (line === undefined) throw new Error("no shell line");

    return line;
  }

  function withGitDiff(gitDiff: unknown): unknown {
    const line = recordedShellLine();

    return { ...line, capture: { ...(line.capture as object), gitDiff } };
  }

  test("a legacy FAILED diff without a cause decodes as unproven", () => {
    const decoded = decodeStateLine(withGitDiff({ status: "FAILED" }));

    expect(decoded).toMatchObject({
      capture: { gitDiff: { status: "FAILED", cause: "UNPROVEN" } },
    });
  });

  test("a limit cause survives the round trip", () => {
    const gitDiff = { status: "FAILED", cause: "LIMIT_EXCEEDED" };
    const decoded = decodeStateLine(JSON.parse(JSON.stringify(withGitDiff(gitDiff))));

    expect(decoded).toMatchObject({ capture: { gitDiff } });
  });

  test("an unknown cause or extra key makes the line invalid", () => {
    expect(decodeStateLine(withGitDiff({ status: "FAILED", cause: "X" }))).toBeNull();
    expect(
      decodeStateLine(withGitDiff({ status: "FAILED", cause: "UNPROVEN", limit: "TOTAL_TIME" })),
    ).toBeNull();
  });

  test("the pre-call limit marker decodes and a damaged one does not", () => {
    expect(decodeShellPreRecord({ v: 1, failed: "LIMIT_EXCEEDED" })).toEqual({
      status: "LIMIT_EXCEEDED",
    });
    expect(decodeShellPreRecord({ v: 1, failed: "OTHER" })).toBeNull();
    expect(decodeShellPreRecord({ v: 2, failed: "LIMIT_EXCEEDED" })).toBeNull();
  });

  test("a snapshot record still decodes as a taken snapshot", () => {
    const snapshot = { toplevel: "/r", head: null, indexDigest: "a".repeat(64), entries: [] };

    expect(decodeShellPreRecord({ v: 1, ...snapshot })).toEqual({ status: "TAKEN", snapshot });
  });
});
