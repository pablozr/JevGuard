import { describe, expect, test } from "vitest";
import {
  categorizeTool,
  type HookEvent,
  type HookEventParseFailure,
  isHookEventParseFailure,
  parseHookEvent,
} from "../src/index";

const COMMON = { session_id: "s1", cwd: "/repo", prompt_id: "p1" };

function parsed(payload: unknown): HookEvent {
  const result = parseHookEvent(payload);

  if (isHookEventParseFailure(result)) throw new Error(`failed: ${result.field}`);

  return result;
}

function failure(payload: unknown): HookEventParseFailure {
  const result = parseHookEvent(payload);

  if (!isHookEventParseFailure(result)) throw new Error("expected failure");

  return result;
}

function bashPost(response: unknown): HookEvent {
  return parsed({
    ...COMMON,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_use_id: "t1",
    tool_input: { command: "ls" },
    tool_response: response,
  });
}

function shellDiffOf(event: HookEvent) {
  if (event.name !== "PostToolUse") throw new Error("not a PostToolUse");

  return event.shellDiff;
}

describe("parseHookEvent envelope", () => {
  test.each([null, undefined, "x", 3, [], true])("rejects non-object payload %j", (payload) => {
    expect(failure(payload)).toEqual({ invalid: true, reason: "NOT_AN_OBJECT", field: "payload" });
  });

  test("rejects missing, mistyped and unknown hook_event_name", () => {
    expect(failure({ ...COMMON })).toMatchObject({
      reason: "MISSING_FIELD",
      field: "hook_event_name",
    });
    expect(failure({ ...COMMON, hook_event_name: 4 })).toMatchObject({
      reason: "INVALID_FIELD",
      field: "hook_event_name",
    });
    expect(failure({ ...COMMON, hook_event_name: "Nope" })).toMatchObject({
      reason: "UNKNOWN_EVENT",
    });
  });

  test.each(["session_id", "cwd"])("requires %s as a non-empty string", (field) => {
    const payload = { ...COMMON, hook_event_name: "SessionStart" };

    expect(failure({ ...payload, [field]: undefined })).toMatchObject({
      reason: "MISSING_FIELD",
      field,
    });
    expect(failure({ ...payload, [field]: 5 })).toMatchObject({ reason: "INVALID_FIELD", field });
    expect(failure({ ...payload, [field]: "" })).toMatchObject({ reason: "INVALID_FIELD", field });
  });

  test.each(["prompt_id", "agent_id"])("rejects a mistyped optional %s", (field) => {
    const payload = { ...COMMON, hook_event_name: "SessionStart", [field]: 7 };

    expect(failure(payload)).toMatchObject({ reason: "INVALID_FIELD", field });
  });

  test("main events have no agent id; subagent events carry it", () => {
    const main = parsed({ ...COMMON, hook_event_name: "SessionStart" });
    const sub = parsed({ ...COMMON, hook_event_name: "SubagentStart", agent_id: "a1" });

    expect(main.agentId).toBeNull();
    expect(sub.agentId).toBe("a1");
  });

  test("failures never echo payload values", () => {
    const secret = "SECRET-VALUE";
    const result = failure({
      ...COMMON,
      hook_event_name: "PreToolUse",
      tool_name: 3,
      tool_use_id: secret,
    });

    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("parseHookEvent prompt and stop", () => {
  test("UserPromptSubmit keeps text and flags non-text as null", () => {
    expect(parsed({ ...COMMON, hook_event_name: "UserPromptSubmit", prompt: "hi" })).toMatchObject({
      prompt: "hi",
    });
    expect(parsed({ ...COMMON, hook_event_name: "UserPromptSubmit", prompt: [1] })).toMatchObject({
      prompt: null,
    });
    expect(parsed({ ...COMMON, hook_event_name: "UserPromptSubmit" })).toMatchObject({
      prompt: null,
    });
  });

  test.each([
    [[], "EMPTY"],
    [[{ id: "b" }], "ACTIVE"],
    [{}, "EMPTY"],
    [{ b: 1 }, "ACTIVE"],
    [undefined, "UNKNOWN"],
    ["x", "UNKNOWN"],
    [null, "UNKNOWN"],
  ])("Stop background_tasks %j is %s", (value, expected) => {
    const event = parsed({ ...COMMON, hook_event_name: "Stop", background_tasks: value });

    expect(event).toMatchObject({ name: "Stop", backgroundTasks: expected, stopHookActive: false });
  });

  test("Stop validates stop_hook_active", () => {
    expect(parsed({ ...COMMON, hook_event_name: "Stop", stop_hook_active: true })).toMatchObject({
      stopHookActive: true,
    });
    expect(failure({ ...COMMON, hook_event_name: "Stop", stop_hook_active: "yes" })).toMatchObject({
      field: "stop_hook_active",
    });
  });

  test("StopFailure parses with the common fields only", () => {
    expect(parsed({ ...COMMON, hook_event_name: "StopFailure" })).toMatchObject({
      name: "StopFailure",
    });
  });
});

describe("parseHookEvent tools", () => {
  const tool = { ...COMMON, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "t1" };

  test("requires tool_name, tool_use_id and an object tool_input", () => {
    expect(failure({ ...tool, tool_name: undefined })).toMatchObject({ field: "tool_name" });
    expect(failure({ ...tool, tool_name: 1 })).toMatchObject({ field: "tool_name" });
    expect(failure({ ...tool, tool_use_id: undefined })).toMatchObject({ field: "tool_use_id" });
    expect(failure({ ...tool, tool_use_id: 1 })).toMatchObject({ field: "tool_use_id" });
    expect(failure({ ...tool, tool_input: "x" })).toMatchObject({ field: "tool_input" });
    expect(failure({ ...tool, tool_input: [] })).toMatchObject({ field: "tool_input" });
  });

  test("edit tools expose file_path or notebook_path", () => {
    const write = parsed({ ...tool, tool_input: { file_path: "/repo/a.ts" } });
    const notebook = parsed({
      ...tool,
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/repo/n.ipynb" },
    });
    const missing = parsed({ ...tool, tool_input: { file_path: 4 } });

    expect(write).toMatchObject({ tool: { category: "EDIT", filePath: "/repo/a.ts" } });
    expect(notebook).toMatchObject({ tool: { filePath: "/repo/n.ipynb" } });
    expect(missing).toMatchObject({ tool: { filePath: null } });
  });

  test("run_in_background is read for shells only", () => {
    const shell = parsed({ ...tool, tool_name: "Bash", tool_input: { run_in_background: true } });
    const edit = parsed({ ...tool, tool_input: { run_in_background: true } });
    const stringy = parsed({
      ...tool,
      tool_name: "Bash",
      tool_input: { run_in_background: "true" },
    });

    expect(shell).toMatchObject({ tool: { runInBackground: true } });
    expect(edit).toMatchObject({ tool: { runInBackground: false } });
    expect(stringy).toMatchObject({ tool: { runInBackground: false } });
  });

  test.each([
    ["Write", "EDIT"],
    ["Edit", "EDIT"],
    ["MultiEdit", "EDIT"],
    ["NotebookEdit", "EDIT"],
    ["Bash", "BASH"],
    ["PowerShell", "POWERSHELL"],
    ["mcp__server__tool", "MCP"],
    ["Agent", "AGENT"],
    ["Task", "AGENT"],
    ["Read", "READONLY"],
    ["Grep", "READONLY"],
    ["SendMessage", "COORDINATION"],
    ["Skill", "COORDINATION"],
    ["SubagentHandback", "COORDINATION"],
    ["TodoWrite", "COORDINATION"],
    ["SomethingNew", "UNKNOWN"],
    ["bash", "UNKNOWN"],
  ])("categorizes %s as %s", (name, category) => {
    expect(categorizeTool(name)).toBe(category);
  });
});

describe("bashEditDiff reading", () => {
  const clean = { changedFiles: [], files: [], moreFiles: 0 };

  test("absent field, missing response and null are ABSENT", () => {
    expect(shellDiffOf(bashPost({ stdout: "" }))).toEqual({ status: "ABSENT" });
    expect(shellDiffOf(bashPost(undefined))).toEqual({ status: "ABSENT" });
    expect(shellDiffOf(bashPost({ bashEditDiff: null }))).toEqual({ status: "ABSENT" });
  });

  test("a clean present diff lists the changed files", () => {
    const diff = { changedFiles: ["/repo/a.ts", { path: "/repo/b.ts" }], files: [], moreFiles: 0 };

    expect(shellDiffOf(bashPost({ bashEditDiff: diff }))).toEqual({
      status: "PRESENT",
      changedFiles: ["/repo/a.ts", "/repo/b.ts"],
    });
    expect(shellDiffOf(bashPost({ bashEditDiff: clean }))).toEqual({
      status: "PRESENT",
      changedFiles: [],
    });
  });

  test.each([
    ["moreFiles above zero", { ...clean, moreFiles: 2 }],
    ["shared true", { ...clean, shared: true }],
    ["unavailable true", { ...clean, unavailable: true }],
    ["skipped true", { ...clean, skipped: true }],
    ["unknown flag shape", { ...clean, shared: "yes" }],
    ["unidentified entry", { ...clean, changedFiles: [{ other: 1 }] }],
    ["changedFiles not an array", { moreFiles: 0, changedFiles: "x" }],
    ["diff not an object", "x"],
  ])("%s is INCOMPLETE", (_name, bashEditDiff) => {
    expect(shellDiffOf(bashPost({ bashEditDiff }))).toEqual({ status: "INCOMPLETE" });
  });

  test("false flags and moreFiles zero are not incompleteness", () => {
    const diff = { ...clean, shared: false, unavailable: false, skipped: false };

    expect(shellDiffOf(bashPost({ bashEditDiff: diff })).status).toBe("PRESENT");
  });

  test("PowerShell responses are never read for a diff", () => {
    const event = parsed({
      ...COMMON,
      hook_event_name: "PostToolUse",
      tool_name: "PowerShell",
      tool_use_id: "t1",
      tool_response: { bashEditDiff: clean },
    });

    expect(shellDiffOf(event)).toEqual({ status: "ABSENT" });
  });
});
