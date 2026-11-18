import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appendStateLines,
  boundStateFile,
  dataDirectoryOf,
  hookLogFileOf,
  lifecycleFileOf,
  LOCK_STALE_MS,
  LOCK_WAIT_MS,
  MAX_LIFECYCLE_BYTES,
  readSessionState,
  runCodexHook,
  sessionDirectoryOf,
  sessionTaintLine,
} from "../src/hook";
import type { CodexSessionState } from "../src/hook";

/**
 * The ways the local state used to go quiet about something that happened: an append
 * another hook made while the file was being bounded, the same append one system call
 * later — between the re-read and the rename, where only the session's write lock covers
 * it — an unreadable line that only marked the unit it first appeared in, and a hook that
 * stood in the host's way for three quarters of a second waiting for a lock it never got,
 * because its window counted sleeps instead of milliseconds. Each one is a guard: it
 * fails without its fix.
 */

/** Where the bounding rewrite can be interrupted by another hook, in one place or another. */
const seam = vi.hoisted(() => ({
  appendWhileBounding: null as null | (() => void),
  appendBeforeRename: null as null | (() => void),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>): void => {
      const [path] = args;
      const append = seam.appendWhileBounding;

      if (
        append !== null &&
        typeof path === "string" &&
        path.includes("lifecycle.jsonl") &&
        path.endsWith(".tmp")
      ) {
        seam.appendWhileBounding = null;
        append();
      }

      actual.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>): void => {
      const [from, to] = args;
      const append = seam.appendBeforeRename;

      if (
        append !== null &&
        typeof from === "string" &&
        from.endsWith(".tmp") &&
        typeof to === "string" &&
        to.includes("lifecycle.jsonl")
      ) {
        seam.appendBeforeRename = null;
        append();
      }

      actual.renameSync(...args);
    },
  };
});

const SESSION = "01a1e7aa-0002-7c00-9000-000000000002";

let pluginData: string;
let session: string;
let lifecycle: string;

function hook(event: string, ids: Readonly<Record<string, string>> = {}): void {
  runCodexHook(JSON.stringify({ session_id: SESSION, hook_event_name: event, ...ids }), {
    environment: { get: () => pluginData },
    now: () => new Date(),
  });
}

function logCodes(): readonly string[] {
  const text = readFileSync(hookLogFileOf(dataDirectoryOf(pluginData)), "utf8");

  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { readonly code: string }).code);
}

/** A file just past its bound, made only of turns that opened and closed. */
function fillWithClosedUnits(size: number): void {
  mkdirSync(session, { recursive: true });

  const lines: string[] = [];
  let bytes = 0;
  let index = 0;

  while (bytes < size) {
    const turn = `u-${index}`;

    lines.push(
      JSON.stringify({ v: 1, kind: "OPEN", turn, at: "2026-11-17T12:00:00.000Z" }),
      JSON.stringify({ v: 1, kind: "CLOSE", turn, at: "2026-11-17T12:00:01.000Z" }),
    );
    bytes += Buffer.byteLength(lines.at(-2) ?? "") + Buffer.byteLength(lines.at(-1) ?? "") + 2;
    index += 1;
  }

  writeFileSync(lifecycle, `${lines.join("\n")}\n`);
}

/**
 * Makes one sleep of the code under test last `times` what it asked for, the way a 1 ms
 * `Atomics.wait` lasts about 15 ms on Windows. Undoes itself at the end of the test.
 */
function slowSleeps(times: number): () => void {
  const original = Atomics.wait;
  const slow = (array: Int32Array, index: number, value: number, timeout?: number): string =>
    original(array, index, value, (timeout ?? 0) * times);

  (Atomics as { wait: typeof Atomics.wait }).wait = slow as typeof Atomics.wait;

  return () => {
    (Atomics as { wait: typeof Atomics.wait }).wait = original;
  };
}

function closedUnit(turnId: string): CodexSessionState["units"][number] {
  return {
    turnId,
    openedAt: "2026-11-17T12:00:00.000Z",
    closedAt: "2026-11-17T12:00:01.000Z",
    calls: [],
    taints: [],
  };
}

beforeEach(() => {
  pluginData = mkdtempSync(join(tmpdir(), "jevguard-codex-guard-"));
  session = sessionDirectoryOf(dataDirectoryOf(pluginData), SESSION);
  lifecycle = lifecycleFileOf(session);
});

afterEach(() => {
  seam.appendWhileBounding = null;
  seam.appendBeforeRename = null;
  rmSync(pluginData, { recursive: true, force: true });
});

describe("bounding the lifecycle file", () => {
  test("never rewrites it while a unit is open, and bounds it once the unit closed", () => {
    fillWithClosedUnits(MAX_LIFECYCLE_BYTES + 2_000);

    const before = readFileSync(lifecycle, "utf8");

    boundStateFile(session, {
      units: [{ ...closedUnit("t-9"), closedAt: null }],
      pendingTaints: [],
      damaged: false,
    });

    expect(readFileSync(lifecycle, "utf8")).toBe(before);

    boundStateFile(session, { units: [closedUnit("t-9")], pendingTaints: [], damaged: false });

    expect(Buffer.byteLength(readFileSync(lifecycle, "utf8"))).toBeLessThan(MAX_LIFECYCLE_BYTES);
  });

  test("an append another hook makes while the file is bounded is not dropped", () => {
    fillWithClosedUnits(MAX_LIFECYCLE_BYTES + 2_000);

    seam.appendWhileBounding = () => {
      appendFileSync(
        lifecycle,
        `${JSON.stringify({ v: 1, kind: "SESSION_TAINT", reason: "UNSUPPORTED_EVENT" })}\n`,
      );
    };

    hook("UserPromptSubmit", { turn_id: "t-1" });

    expect(readFileSync(lifecycle, "utf8")).toContain('"SESSION_TAINT"');

    for (let index = 0; index < 8; index += 1) {
      hook("PreToolUse", { turn_id: "t-1", tool_use_id: `call-${index}` });
      hook("PostToolUse", { turn_id: "t-1", tool_use_id: `call-${index}` });
    }

    hook("Stop", { turn_id: "t-1" });

    const unit = readSessionState(session).units.at(-1);

    expect(unit?.turnId).toBe("t-1");
    expect(unit?.taints).toEqual(["UNSUPPORTED_EVENT"]);
    expect(logCodes()).toContain("UNIT_UNAVAILABLE");
    expect(logCodes()).not.toContain("TURN_CLOSED");
  });

  test("an append landing between the re-read and the rename is not dropped", () => {
    fillWithClosedUnits(MAX_LIFECYCLE_BYTES + 2_000);

    // The other hook appends at the last moment of the rewrite, past the re-read: only
    // the lock it and the rewrite share can keep its line out of the replaced file.
    seam.appendBeforeRename = () => {
      appendStateLines(session, [sessionTaintLine("UNSUPPORTED_EVENT")]);
    };

    hook("UserPromptSubmit", { turn_id: "t-1" });

    expect(readFileSync(lifecycle, "utf8")).toContain('"SESSION_TAINT"');

    hook("PreToolUse", { turn_id: "t-1", tool_use_id: "c-1" });
    hook("PostToolUse", { turn_id: "t-1", tool_use_id: "c-1" });
    hook("Stop", { turn_id: "t-1" });

    const unit = readSessionState(session).units.at(-1);

    expect(unit?.turnId).toBe("t-1");
    expect(unit?.taints).toEqual(["UNSUPPORTED_EVENT"]);
    expect(logCodes()).toContain("UNIT_UNAVAILABLE");
    expect(logCodes()).not.toContain("TURN_CLOSED");
    expect(readdirSync(session)).not.toContain("lifecycle.lock");
  });

  test("a lock left by a hook that died is broken once it is old enough", () => {
    hook("UserPromptSubmit", { turn_id: "t-1" });

    const lock = join(session, "lifecycle.lock");
    const longAgo = new Date(Date.now() - LOCK_STALE_MS - 1_000);

    writeFileSync(lock, "");
    utimesSync(lock, longAgo, longAgo);

    hook("PreToolUse", { turn_id: "t-1", tool_use_id: "c-1" });

    expect(readFileSync(lifecycle, "utf8")).toContain('"CALL"');
    expect(readdirSync(session)).not.toContain("lifecycle.lock");
  });

  test("a lock another hook holds is waited for by the clock, not by a count of sleeps", () => {
    fillWithClosedUnits(MAX_LIFECYCLE_BYTES + 2_000);

    const before = readFileSync(lifecycle, "utf8");
    const lock = join(session, "lifecycle.lock");

    // A lock taken this instant cannot be broken by age: every attempt fails, and the
    // rewrite has to give up within its window.
    writeFileSync(lock, "");

    // A sleep of 1 ms lasts about 15 ms on Windows, which is what made a window counted in
    // sleeps last three quarters of a second. Making every sleep ten times what it asks
    // for shows the same difference on a platform whose sleeps are true milliseconds.
    const restore = slowSleeps(10);
    const started = performance.now();

    try {
      boundStateFile(session, { units: [closedUnit("t-9")], pendingTaints: [], damaged: false });
    } finally {
      restore();
    }

    const waited = performance.now() - started;

    expect(waited).toBeLessThan(LOCK_WAIT_MS * 4);
    expect(readFileSync(lifecycle, "utf8")).toBe(before);
    expect(readdirSync(session)).toContain("lifecycle.lock");
  });
});

describe("an unreadable line", () => {
  test("marks the unit open where it appeared, and the next one too", () => {
    hook("UserPromptSubmit", { turn_id: "t-1" });
    appendFileSync(lifecycle, "garbage-1\n");
    hook("Stop", { turn_id: "t-1" });

    expect(readSessionState(session).units.at(-1)?.taints).toEqual(["STATE_DAMAGED"]);

    hook("UserPromptSubmit", { turn_id: "t-2" });
    appendFileSync(lifecycle, '{"v":1,"kind":"TAINT","tur\n');
    hook("Stop", { turn_id: "t-2" });

    const unit = readSessionState(session).units.at(-1);

    expect(unit?.turnId).toBe("t-2");
    expect(unit?.taints).toEqual(["STATE_DAMAGED"]);
  });

  test("marks a unit that opens after it, when no unit was open at the time", () => {
    hook("UserPromptSubmit", { turn_id: "t-1" });
    hook("Stop", { turn_id: "t-1" });

    appendFileSync(lifecycle, "garbage\n");

    hook("UserPromptSubmit", { turn_id: "t-2" });
    hook("Stop", { turn_id: "t-2" });

    const units = readSessionState(session).units;

    expect(units[0]?.taints).toEqual([]);
    expect(units.at(-1)?.taints).toEqual(["STATE_DAMAGED"]);
    expect(logCodes()).toContain("UNIT_UNAVAILABLE");
  });
});
