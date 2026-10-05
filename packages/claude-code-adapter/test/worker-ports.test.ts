import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ClaudeReviewHandoff } from "../src/hook";
import { createFileHandoffSink, spawnDetachedWorker } from "../src/hook";
import { createTimerDeadline } from "../src/worker";

afterEach(() => {
  vi.useRealTimers();
});

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: SpawnOptions;
}

function recordingPorts(entryExists: boolean) {
  const calls: SpawnCall[] = [];
  let unreferenced = 0;
  const child = { on: () => child, unref: () => (unreferenced += 1) } as unknown as ChildProcess;

  return {
    calls,
    unreferenced: () => unreferenced,
    ports: {
      exists: () => entryExists,
      spawn: (command: string, args: readonly string[], options: SpawnOptions) => {
        calls.push({ command, args, options });

        return child;
      },
    },
  };
}

describe("spawnDetachedWorker", () => {
  const hookEntry = resolve("/plugin/dist/hook.js");

  test("starts a detached, silent, hidden process and does not wait for it", () => {
    const { calls, ports, unreferenced } = recordingPorts(true);
    const result = spawnDetachedWorker(hookEntry, { CLAUDE_PLUGIN_DATA: "/data" }, ports);

    expect(result).toBe("STARTED");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(process.execPath);
    expect(calls[0]?.args).toEqual([join(resolve("/plugin/dist"), "worker.js")]);
    expect(calls[0]?.options).toMatchObject({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { CLAUDE_PLUGIN_DATA: "/data" },
    });
    expect(unreferenced()).toBe(1);
  });

  test("a missing worker file is reported and nothing is spawned", () => {
    const { calls, ports } = recordingPorts(false);

    expect(spawnDetachedWorker(hookEntry, {}, ports)).toBe("ENTRY_MISSING");
    expect(calls).toEqual([]);
  });

  test("a missing or relative hook entrypoint throws instead of resolving against the cwd", () => {
    const { calls, ports } = recordingPorts(true);

    expect(() => spawnDetachedWorker(undefined, {}, ports)).toThrow();
    expect(() => spawnDetachedWorker("hook.js", {}, ports)).toThrow();
    expect(calls).toEqual([]);
  });
});

describe("createTimerDeadline", () => {
  test("a result in time is returned and its timer is cleared", async () => {
    vi.useFakeTimers();

    const result = await createTimerDeadline().race(Promise.resolve("ok"), 1_000);

    expect(result).toEqual({ status: "DONE", value: "ok" });
    expect(vi.getTimerCount()).toBe(0);
  });

  test("a late result is discarded after the deadline", async () => {
    vi.useFakeTimers();

    let finish: (value: string) => void = () => undefined;
    const late = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const racing = createTimerDeadline().race(late, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    expect(await racing).toEqual({ status: "DEADLINE" });

    finish("late");

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("handoff publication without hard links", () => {
  test("a partial .json is never visible while the handoff is published", () => {
    const directory = mkdtempSync(join(tmpdir(), "jevguard-handoff-"));
    const handoff: ClaudeReviewHandoff = {
      version: 1,
      turnId: "claude-code:s:e:0",
      sessionId: "s",
      ordinal: 0,
      epoch: "e",
      projectRoot: "/p",
      closedAt: "2026-10-05T00:00:00.000Z",
      shellCoverage: [],
      resolution: { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" },
    };
    const visibleAtLink: string[][] = [];

    try {
      const sink = createFileHandoffSink(directory, () => {
        visibleAtLink.push(readdirSync(directory));

        throw Object.assign(new Error("no links"), { code: "EPERM" });
      });

      expect(sink.deliver(handoff)).toBe("CREATED");
      expect(visibleAtLink[0]?.some((name) => name.endsWith(".json"))).toBe(false);

      const published = readdirSync(directory);

      expect(published).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(directory, published[0] ?? ""), "utf8"))).toEqual(
        handoff,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
