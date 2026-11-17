import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type {
  CodexHookPayload,
  CodexPostToolUsePayload,
  CodexPreToolUsePayload,
  CodexSessionEndPayload,
  CodexStopPayload,
  CodexUserPromptSubmitPayload,
} from "../src/index";

/**
 * What the F0 smoke test proved about `codex-cli 0.162.1`, checked against the
 * payloads the host actually sent (see `fixtures/README.md` for the capture).
 * The exit criterion of the slice is the pairing test: the payload proves one
 * `tool_use_id` per call across `PreToolUse`/`PostToolUse`, and one `turn_id`
 * for the whole turn.
 */

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

interface Captured {
  /** File name; the numeric prefix is the capture order. */
  readonly file: string;
  readonly payload: CodexHookPayload;
}

function capture(session: string): readonly Captured[] {
  const dir = join(FIXTURES, session);

  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      payload: JSON.parse(readFileSync(join(dir, file), "utf8")) as CodexHookPayload,
    }));
}

function preToolCalls(captured: readonly Captured[]): readonly CodexPreToolUsePayload[] {
  return captured
    .map((entry) => entry.payload)
    .filter(
      (payload): payload is CodexPreToolUsePayload => payload.hook_event_name === "PreToolUse",
    );
}

function postToolCalls(captured: readonly Captured[]): readonly CodexPostToolUsePayload[] {
  return captured
    .map((entry) => entry.payload)
    .filter(
      (payload): payload is CodexPostToolUsePayload => payload.hook_event_name === "PostToolUse",
    );
}

function single<T extends CodexHookPayload["hook_event_name"]>(
  captured: readonly Captured[],
  name: T,
): Extract<CodexHookPayload, { hook_event_name: T }> {
  const matches = captured
    .map((entry) => entry.payload)
    .filter((payload): payload is Extract<CodexHookPayload, { hook_event_name: T }> => {
      return payload.hook_event_name === name;
    });

  expect(matches).toHaveLength(1);

  return matches[0] as Extract<CodexHookPayload, { hook_event_name: T }>;
}

describe("a complete Codex turn", () => {
  const captured = capture("session-complete");

  test("every payload belongs to one session running in one directory", () => {
    expect(captured.length).toBeGreaterThan(0);

    const sessionIds = new Set(captured.map((entry) => entry.payload.session_id));
    const directories = new Set(captured.map((entry) => entry.payload.cwd));

    expect(sessionIds.size).toBe(1);
    expect(directories.size).toBe(1);
  });

  test("the turn opens on UserPromptSubmit and closes on Stop with the same turn_id", () => {
    const prompt = single(captured, "UserPromptSubmit") satisfies CodexUserPromptSubmitPayload;
    const stop = single(captured, "Stop") satisfies CodexStopPayload;

    expect(prompt.turn_id.length).toBeGreaterThan(0);
    expect(prompt.prompt.length).toBeGreaterThan(0);
    expect(stop.turn_id).toBe(prompt.turn_id);
    expect(stop.stop_hook_active).toBe(false);
    expect(captured[0]?.payload.hook_event_name).toBe("SessionStart");
    expect(captured.at(-1)?.payload.hook_event_name).toBe("Stop");
  });

  test("every tool call pairs its two halves on one tool_use_id and one turn_id", () => {
    const pre = preToolCalls(captured);
    const post = postToolCalls(captured);

    expect(pre.length).toBeGreaterThan(0);
    expect(pre.length).toBe(post.length);

    const turnIds = new Set([...pre, ...post].map((payload) => payload.turn_id));

    expect(turnIds).toEqual(new Set([single(captured, "UserPromptSubmit").turn_id]));

    for (const before of pre) {
      const after = post.filter((payload) => payload.tool_use_id === before.tool_use_id);

      expect(after).toHaveLength(1);
      expect(after[0]?.tool_name).toBe(before.tool_name);
      expect(after[0]?.turn_id).toBe(before.turn_id);
      expect(after[0]?.tool_input).toEqual(before.tool_input);
      expect(before.tool_use_id.startsWith("exec-")).toBe(true);
    }

    // The id is unique per call: no two calls share one.
    const ids = new Set([...pre, ...post].map((payload) => payload.tool_use_id));

    expect(ids.size).toBe(pre.length);
  });

  test("PreToolUse always comes before the PostToolUse of the same call", () => {
    const order = captured.map((entry) => entry.payload);

    for (const before of preToolCalls(captured)) {
      const preIndex = order.indexOf(before);
      const postIndex = order.findIndex(
        (payload) =>
          payload.hook_event_name === "PostToolUse" && payload.tool_use_id === before.tool_use_id,
      );

      expect(preIndex).toBeGreaterThanOrEqual(0);
      expect(postIndex).toBeGreaterThan(preIndex);
    }
  });

  test("the three write-capable tool paths are covered: shell, patch and MCP", () => {
    const names = preToolCalls(captured).map((payload) => payload.tool_name);

    expect(names).toEqual(["Bash", "apply_patch", "mcp__f0demo__echo"]);
  });

  test("apply_patch carries the whole patch in tool_input.command", () => {
    const patch = preToolCalls(captured).find((payload) => payload.tool_name === "apply_patch");
    const command = patch?.tool_input.command;

    expect(typeof command).toBe("string");

    if (typeof command !== "string") throw new Error("apply_patch without a patch");

    expect(command.startsWith("*** Begin Patch\n")).toBe(true);
    expect(command).toContain("*** Add File: ");
    expect(command.trimEnd().endsWith("*** End Patch")).toBe(true);
  });

  test("tool_response has the host's own shape for each tool kind", () => {
    const post = postToolCalls(captured);
    const bash = post.find((payload) => payload.tool_name === "Bash");
    const patch = post.find((payload) => payload.tool_name === "apply_patch");
    const mcp = post.find((payload) => payload.tool_name === "mcp__f0demo__echo");

    expect(typeof bash?.tool_response).toBe("string");
    expect(typeof patch?.tool_response).toBe("string");
    expect(patch?.tool_response).toContain("Success. Updated the following files:");
    expect(mcp?.tool_response).toMatchObject({
      content: [{ type: "text", text: "echo: ping" }],
    });
  });
});

describe("a Codex turn whose calls were refused", () => {
  const captured = capture("session-refused");

  test("a refused call leaves a PreToolUse with no PostToolUse", () => {
    const pre = preToolCalls(captured);

    expect(pre.map((payload) => payload.tool_name)).toEqual(["Bash", "mcp__f0demo__echo"]);
    expect(postToolCalls(captured)).toHaveLength(0);
  });

  test("Stop still closes the turn of the refused calls", () => {
    const stop = single(captured, "Stop");
    const turnIds = new Set(preToolCalls(captured).map((payload) => payload.turn_id));

    expect(turnIds).toEqual(new Set([stop.turn_id]));
  });

  test("SessionEnd carries neither turn_id nor model", () => {
    const end = single(captured, "SessionEnd") satisfies CodexSessionEndPayload;

    expect(end).not.toHaveProperty("turn_id");
    expect(end).not.toHaveProperty("model");
    expect(end).not.toHaveProperty("permission_mode");
    expect(end.reason).toBe("other");
  });
});

describe("the captured fixtures", () => {
  test("never carry the transcript path, which is not evidence", () => {
    for (const session of ["session-complete", "session-refused"]) {
      for (const { payload } of capture(session)) {
        expect(payload).not.toHaveProperty("transcript_path");
      }
    }
  });
});
