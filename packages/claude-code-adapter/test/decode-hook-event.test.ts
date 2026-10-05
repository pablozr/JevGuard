import { describe, expect, test } from "vitest";
import type { HookEvent } from "../src/index";
import { decodeHookEvent, isHookEventParseFailure, parseHookEvent } from "../src/index";

const BASE = { session_id: "s1", cwd: "/repo", prompt_id: "p1" };
const EDIT_TOOL = {
  tool_name: "Write",
  tool_use_id: "t1",
  tool_input: { file_path: "/repo/a.ts" },
};

function parsed(payload: Record<string, unknown>): HookEvent {
  const event = parseHookEvent({ ...BASE, ...payload });

  if (isHookEventParseFailure(event)) throw new Error("fixture failed to parse");

  return event;
}

const EVENTS: Readonly<Record<string, HookEvent>> = {
  SessionStart: parsed({ hook_event_name: "SessionStart" }),
  SessionEnd: parsed({ hook_event_name: "SessionEnd" }),
  SubagentStart: parsed({ hook_event_name: "SubagentStart", agent_id: "a1" }),
  SubagentStop: parsed({ hook_event_name: "SubagentStop", agent_id: "a1" }),
  StopFailure: parsed({ hook_event_name: "StopFailure" }),
  UserPromptSubmit: parsed({ hook_event_name: "UserPromptSubmit", prompt: "hello" }),
  UserPromptSubmitNotText: parsed({ hook_event_name: "UserPromptSubmit" }),
  PreToolUse: parsed({ hook_event_name: "PreToolUse", ...EDIT_TOOL }),
  PostToolUseFailure: parsed({ hook_event_name: "PostToolUseFailure", ...EDIT_TOOL }),
  PostToolUseEdit: parsed({ hook_event_name: "PostToolUse", ...EDIT_TOOL }),
  PostToolUseBashPresent: parsed({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "t2",
    tool_input: { run_in_background: false },
    tool_response: { bashEditDiff: { changedFiles: ["/repo/a.ts"] } },
  }),
  PostToolUseBashIncomplete: parsed({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "t3",
    tool_response: { bashEditDiff: { changedFiles: [], skipped: true } },
  }),
  Stop: parsed({ hook_event_name: "Stop", background_tasks: [], stop_hook_active: true }),
  StopActive: parsed({ hook_event_name: "Stop", background_tasks: [{ id: "b" }] }),
  StopUnknown: parsed({ hook_event_name: "Stop" }),
};

function roundTrip(event: HookEvent): unknown {
  return JSON.parse(JSON.stringify(event));
}

describe("decodeHookEvent round trip", () => {
  test.each(Object.entries(EVENTS))("%s survives serialization", (_name, event) => {
    expect(decodeHookEvent(roundTrip(event))).toEqual(event);
  });
});

describe("decodeHookEvent rejects tampering", () => {
  const stored = (name: string): Record<string, unknown> => {
    const value = roundTrip(EVENTS[name] as HookEvent);

    if (typeof value !== "object" || value === null) throw new Error("not an object");

    return { ...value };
  };

  test.each([
    ["a non-object", "text"],
    ["null", null],
    ["an array", []],
  ])("%s is rejected", (_label, value) => {
    expect(isHookEventParseFailure(decodeHookEvent(value))).toBe(true);
  });

  test.each([
    ["an unknown name", { ...stored("Stop"), name: "Bogus" }],
    ["an inherited name", { ...stored("Stop"), name: "toString" }],
    ["an extra key", { ...stored("Stop"), extra: 1 }],
    ["a missing key", { ...stored("Stop"), stopHookActive: undefined }],
    ["an empty session", { ...stored("Stop"), sessionId: "" }],
    ["a numeric cwd", { ...stored("Stop"), cwd: 4 }],
    ["an empty prompt id", { ...stored("Stop"), promptId: "" }],
    ["a bad background state", { ...stored("Stop"), backgroundTasks: "MAYBE" }],
    ["a non-boolean stop flag", { ...stored("Stop"), stopHookActive: "yes" }],
    ["a numeric prompt", { ...stored("UserPromptSubmit"), prompt: 3 }],
  ])("%s is rejected", (_label, value) => {
    expect(isHookEventParseFailure(decodeHookEvent(value))).toBe(true);
  });

  test("a tool that disagrees with its category or carries foreign fields is rejected", () => {
    const edit = stored("PreToolUse");
    const tool = edit.tool as Record<string, unknown>;
    const cases = [
      { ...tool, category: "BASH" },
      { ...tool, toolName: "Bash" },
      { ...tool, toolUseId: "" },
      { ...tool, filePath: 7 },
      { ...tool, runInBackground: true },
      { ...tool, extra: true },
      { toolName: "Write" },
    ];

    for (const bad of cases) {
      expect(isHookEventParseFailure(decodeHookEvent({ ...edit, tool: bad }))).toBe(true);
    }
  });

  test("a path on a non-edit tool is rejected", () => {
    const bash = stored("PostToolUseBashPresent");
    const tool = bash.tool as Record<string, unknown>;

    expect(
      isHookEventParseFailure(decodeHookEvent({ ...bash, tool: { ...tool, filePath: "/x" } })),
    ).toBe(true);
  });

  test.each([
    ["an unknown status", { status: "MAYBE" }],
    ["a present diff without files", { status: "PRESENT" }],
    ["an absent diff with files", { status: "ABSENT", changedFiles: [] }],
    ["non-string files", { status: "PRESENT", changedFiles: [1] }],
    ["empty file names", { status: "PRESENT", changedFiles: [""] }],
    ["a missing diff", undefined],
  ])("a post event with %s is rejected", (_label, shellDiff) => {
    const post = stored("PostToolUseBashPresent");

    expect(isHookEventParseFailure(decodeHookEvent({ ...post, shellDiff }))).toBe(true);
  });
});
