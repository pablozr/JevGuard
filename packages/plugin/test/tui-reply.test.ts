import { describe, expect, test } from "vitest";
import { readPromptResult } from "../src/tui/reply";

const MESSAGE_ID = "msg_assistant";
const PARENT_ID = "msg_user";

interface DataOverrides {
  readonly info?: Record<string, unknown>;
  readonly parts?: unknown;
}

function promptData(overrides: DataOverrides = {}): unknown {
  const info = {
    id: MESSAGE_ID,
    role: "assistant",
    parentID: PARENT_ID,
    time: { created: 1, completed: 2 },
    ...overrides.info,
  };

  return {
    info,
    parts: "parts" in overrides ? overrides.parts : [{ type: "text", text: "  done  " }],
  };
}

describe("readPromptResult", () => {
  test("accepts a completed assistant reply and trims its text", () => {
    expect(readPromptResult({ data: promptData() })).toEqual({ status: "OK", value: "done" });
  });

  test("joins only literal text parts and ignores every other part type", () => {
    const result = readPromptResult({
      data: promptData({
        parts: [
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "first" },
          { type: "tool" },
          { type: "text", text: "second" },
        ],
      }),
    });

    expect(result).toEqual({ status: "OK", value: "first\nsecond" });
  });

  test.each([
    ["a transport error field", { error: { name: "UnknownError" }, data: promptData() }],
    ["missing data", { error: undefined }],
    ["null data", { data: null }],
    ["a primitive result", "not-a-result"],
    ["an info error", { data: promptData({ info: { error: { name: "MessageAbortedError" } } }) }],
    ["a non-assistant role", { data: promptData({ info: { role: "user" } }) }],
    ["a missing completion time", { data: promptData({ info: { time: { created: 1 } } }) }],
    [
      "a non-finite completion time",
      { data: promptData({ info: { time: { created: 1, completed: Number.NaN } } }) },
    ],
    ["a summary message", { data: promptData({ info: { summary: true } }) }],
    ["a missing parent", { data: promptData({ info: { parentID: "" } }) }],
    ["an absent message id", { data: promptData({ info: { id: undefined } }) }],
    ["an empty message id", { data: promptData({ info: { id: "" } }) }],
    ["a missing creation time", { data: promptData({ info: { time: { completed: 2 } } }) }],
    [
      "a non-finite creation time",
      { data: promptData({ info: { time: { created: Number.NaN, completed: 2 } } }) },
    ],
    ["text-free parts", { data: promptData({ parts: [{ type: "tool" }] }) }],
    ["whitespace-only text", { data: promptData({ parts: [{ type: "text", text: "   " }] }) }],
    ["parts that are not a list", { data: promptData({ parts: "text" }) }],
    ["a missing info", { data: { parts: [] } }],
  ])("rejects %s", (_label, result) => {
    expect(readPromptResult(result)).toEqual({ status: "FAILED" });
  });
});
