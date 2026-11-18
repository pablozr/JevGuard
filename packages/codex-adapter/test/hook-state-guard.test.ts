import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  boundStateFile,
  dataDirectoryOf,
  hookLogFileOf,
  lifecycleFileOf,
  MAX_LIFECYCLE_BYTES,
  readSessionState,
  runCodexHook,
  sessionDirectoryOf,
} from "../src/hook";
import type { CodexSessionState } from "../src/hook";

/**
 * The two ways the local state used to go quiet about something that happened: an append
 * another hook made while the file was being bounded, and an unreadable line that only
 * marked the unit it first appeared in. Both are guards — each one fails without its fix.
 */

/** Runs where the bounding rewrite writes its temporary file: another hook's append. */
const seam = vi.hoisted(() => ({ appendWhileBounding: null as null | (() => void) }));

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
