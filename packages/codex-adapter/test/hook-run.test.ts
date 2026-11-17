import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  dataDirectoryOf,
  heartbeatFileOf,
  hookLogFileOf,
  lifecycleFileOf,
  readSessionState,
  runCodexHook,
  sessionDirectoryOf,
} from "../src/hook";

/**
 * The hook as the host runs it: one process per event, state on disk, a closed code in the
 * log. These tests replay the captured sessions through the real filesystem and check
 * both what the unit became and what the log and the state are allowed to hold.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

const SESSION = "01a1e7aa-0001-7c00-9000-000000000001";

let pluginData: string;

function stdinsOf(session: string): readonly string[] {
  const dir = join(FIXTURES, session);

  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"));
}

function runAll(stdins: readonly string[]): void {
  for (const stdin of stdins) {
    runCodexHook(stdin, { environment: { get: () => pluginData }, now: () => new Date() });
  }
}

function logCodes(): readonly string[] {
  const text = readFileSync(hookLogFileOf(dataDirectoryOf(pluginData)), "utf8");

  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => (JSON.parse(line) as { readonly code: string }).code);
}

function allStateText(): string {
  const data = dataDirectoryOf(pluginData);
  const session = sessionDirectoryOf(data, SESSION);
  const files = [hookLogFileOf(data), lifecycleFileOf(session), heartbeatFileOf(session)];

  return files.map((file) => readFileSync(file, "utf8")).join("\n");
}

beforeEach(() => {
  pluginData = mkdtempSync(join(tmpdir(), "jevguard-codex-"));
});

afterEach(() => {
  rmSync(pluginData, { recursive: true, force: true });
});

describe("a captured session through the hook", () => {
  test("the complete turn opens once, pairs three calls and closes complete", () => {
    runAll(stdinsOf("session-complete"));

    expect(logCodes()).toEqual(["SESSION_START", "TURN_OPENED", "TURN_CLOSED"]);

    const state = readSessionState(sessionDirectoryOf(dataDirectoryOf(pluginData), SESSION));

    expect(state.units).toHaveLength(1);
    expect(state.damaged).toBe(false);
    expect(state.units[0]?.calls.every((call) => call.paired)).toBe(true);
    expect(state.units[0]?.taints).toEqual([]);
  });

  test("the refused turn closes unavailable, never as if nothing happened", () => {
    runAll(stdinsOf("session-refused"));

    expect(logCodes()).toEqual([
      "SESSION_START",
      "TURN_OPENED",
      "TOOL_CALL_UNPAIRED",
      "UNIT_UNAVAILABLE",
    ]);
  });

  test("neither the log nor the state holds the task, the patch or a path", () => {
    runAll(stdinsOf("session-complete"));
    runAll(stdinsOf("session-refused"));

    const text = allStateText();

    for (const forbidden of [
      "Do exactly these three steps",
      "notes.txt",
      "hello-f0",
      "smoke",
      "C:\\\\work",
      "transcript",
      "*** Begin Patch",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test("SessionEnd drops the session's state", () => {
    runAll(stdinsOf("session-refused"));

    const session = sessionDirectoryOf(dataDirectoryOf(pluginData), SESSION);

    expect(() => readdirSync(session)).toThrow();
  });
});

describe("what the hook does when it cannot read the host", () => {
  test("says nothing at all without the host's plugin data directory", () => {
    expect(() =>
      runCodexHook(
        JSON.stringify({
          session_id: SESSION,
          hook_event_name: "UserPromptSubmit",
          turn_id: "t-1",
        }),
        { environment: { get: () => undefined }, now: () => new Date() },
      ),
    ).not.toThrow();

    expect(readdirSync(pluginData)).toEqual([]);
  });

  test("a payload with no turn marks the session, and its Stop can only end unavailable", () => {
    runCodexHook(JSON.stringify({ session_id: SESSION, hook_event_name: "UserPromptSubmit" }), {
      environment: { get: () => pluginData },
      now: () => new Date(),
    });
    runCodexHook(JSON.stringify({ session_id: SESSION, hook_event_name: "Stop", turn_id: "t-1" }), {
      environment: { get: () => pluginData },
      now: () => new Date(),
    });

    expect(logCodes()).toEqual([
      "PARSE_FAILED:MISSING_TURN_ID",
      "PAYLOAD_UNREADABLE",
      "HOOK_NOT_TRUSTED",
      "UNIT_UNAVAILABLE",
    ]);
  });

  test("an event outside the slice marks the session", () => {
    runCodexHook(
      JSON.stringify({
        session_id: SESSION,
        turn_id: "t-1",
        hook_event_name: "SubagentStart",
      }),
      { environment: { get: () => pluginData }, now: () => new Date() },
    );
    runCodexHook(JSON.stringify({ session_id: SESSION, hook_event_name: "Stop", turn_id: "t-1" }), {
      environment: { get: () => pluginData },
      now: () => new Date(),
    });

    expect(logCodes()).toEqual([
      "UNSUPPORTED_EVENT",
      "UNSUPPORTED_EVENT",
      "HOOK_NOT_TRUSTED",
      "UNIT_UNAVAILABLE",
    ]);
  });

  test("a damaged lifecycle file is named once and its unit can only end unavailable", () => {
    runAll(stdinsOf("session-complete").slice(0, 2));

    const session = sessionDirectoryOf(dataDirectoryOf(pluginData), SESSION);

    writeFileSync(lifecycleFileOf(session), "not a lifecycle line\n");

    runCodexHook(JSON.stringify({ session_id: SESSION, hook_event_name: "Stop", turn_id: "t-1" }), {
      environment: { get: () => pluginData },
      now: () => new Date(),
    });

    expect(logCodes()).toEqual([
      "SESSION_START",
      "TURN_OPENED",
      "STATE_READ_FAILED",
      "HOOK_NOT_TRUSTED",
      "UNIT_UNAVAILABLE",
    ]);

    const state = readSessionState(session);

    expect(state.damaged).toBe(true);
    expect(state.units.at(-1)?.taints).toContain("STATE_DAMAGED");
  });
});
