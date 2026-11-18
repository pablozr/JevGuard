import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { decodeHookPayload } from "../src/hook";

/**
 * The decoder is the one place a host payload becomes something the hook may keep. These
 * tests pin two things: the six events of the F0 capture decode in order, and nothing the
 * contract forbids — task text, model output, paths, tool inputs — survives it.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

function stdinsOf(session: string): readonly string[] {
  const dir = join(FIXTURES, session);

  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readFileSync(join(dir, file), "utf8"));
}

function eventsOf(session: string) {
  return stdinsOf(session).map((stdin) => decodeHookPayload(stdin));
}

describe("decoding a real session", () => {
  test("the complete turn becomes one session start, one turn and its three paired calls", () => {
    const decoded = eventsOf("session-complete");

    expect(decoded.map((result) => result.status === "EVENT" && result.event.kind)).toEqual([
      "SESSION_START",
      "TURN_OPEN",
      "TOOL_PRE",
      "TOOL_POST",
      "TOOL_PRE",
      "TOOL_POST",
      "TOOL_PRE",
      "TOOL_POST",
      "TURN_CLOSE",
    ]);
  });

  test("every event names the captured session and turn", () => {
    const sessions = new Set<string>();
    const turns = new Set<string>();

    for (const result of eventsOf("session-complete")) {
      if (result.status !== "EVENT") throw new Error("the fixture must decode");
      if (!("turnId" in result.event)) {
        sessions.add(result.event.sessionId);
        continue;
      }

      turns.add(result.event.turnId);
    }

    expect([...sessions]).toEqual(["01a1e7aa-0001-7c00-9000-000000000001"]);
    expect([...turns]).toEqual(["01a1e7aa-0002-7c00-9000-000000000002"]);
  });

  test("a refused call keeps its opening half and gets no closing half", () => {
    const decoded = eventsOf("session-refused");
    const calls = decoded.flatMap((result) =>
      result.status === "EVENT" && "toolUseId" in result.event
        ? [{ kind: result.event.kind, id: result.event.toolUseId }]
        : [],
    );

    expect(calls.map((call) => call.kind)).toEqual(["TOOL_PRE", "TOOL_PRE"]);
    expect(new Set(calls.map((call) => call.id)).size).toBe(2);
  });

  test("no task text, model output, path or tool input reaches the event", () => {
    for (const session of ["session-complete", "session-refused"]) {
      for (const stdin of stdinsOf(session)) {
        const result = decodeHookPayload(stdin);

        if (result.status !== "EVENT") throw new Error("the fixture must decode");

        const kept = JSON.stringify(result.event);

        expect(kept).not.toContain("Do exactly these three steps");
        expect(kept).not.toContain("done");
        expect(kept).not.toContain("notes.txt");
        expect(kept).not.toContain("hello-f0");
        expect(kept).not.toContain("C:\\\\work");
        expect(kept).not.toContain("transcript");
      }
    }
  });
});

describe("refusing what it cannot attribute", () => {
  test("is not JSON", () => {
    const result = decodeHookPayload("{ nope");

    expect(result).toMatchObject({ status: "FAILED", reason: "NOT_JSON", sessionId: null });
  });

  test("has no session", () => {
    expect(decodeHookPayload(JSON.stringify({ hook_event_name: "Stop" }))).toMatchObject({
      status: "FAILED",
      reason: "MISSING_SESSION_ID",
    });
  });

  test("has no turn, with the session kept for the mark", () => {
    const result = decodeHookPayload(
      JSON.stringify({ session_id: "s-1", hook_event_name: "UserPromptSubmit" }),
    );

    expect(result).toMatchObject({
      status: "FAILED",
      reason: "MISSING_TURN_ID",
      sessionId: "s-1",
      event: "UserPromptSubmit",
    });
  });

  test("has no tool-call id", () => {
    const result = decodeHookPayload(
      JSON.stringify({
        session_id: "s-1",
        turn_id: "t-1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "echo hi" },
      }),
    );

    expect(result).toMatchObject({ status: "FAILED", reason: "MISSING_TOOL_USE_ID" });
  });

  test("is an event outside the slice, which marks the session instead of being ignored", () => {
    const result = decodeHookPayload(
      JSON.stringify({ session_id: "s-1", turn_id: "t-1", hook_event_name: "SubagentStart" }),
    );

    expect(result).toMatchObject({
      status: "FAILED",
      reason: "UNSUPPORTED_EVENT",
      sessionId: "s-1",
      event: null,
    });
  });
});
