import {
  DEFAULT_EVIDENCE_POLICY,
  type EvidenceSlice,
  type ParsedRule,
  planRuleEvidence,
} from "@jevguard/core";
import { describe, expect, test } from "vitest";
import { type AcquiredUnit, encodeTask, resolveAcquisition, toTurn, turnId } from "../src/index";
import { image, Scenario } from "./scenario";

const RULE: ParsedRule = {
  id: "R-1",
  severity: "error",
  scope: null,
  evidence: "code",
  description: "A rule.",
  violation: "A violation.",
  allowed: null,
};

function lines(count: number, replacements: Readonly<Record<number, string>> = {}): string {
  const rows = Array.from({ length: count }, (_, index) => replacements[index] ?? `line ${index}`);

  return `${rows.join("\n")}\n`;
}

function unitOf(files: AcquiredUnit["files"], prompts: readonly string[] = ["task"]): AcquiredUnit {
  return { sessionId: "s1", ordinal: 0, prompts, files };
}

function planned(turn: ReturnType<typeof toTurn>, maxDiffLength: number): readonly EvidenceSlice[] {
  const plan = planRuleEvidence(turn, RULE, { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength });

  if (plan.status !== "PLANNED") throw new Error(`expected PLANNED, got ${plan.status}`);

  return plan.slices;
}

describe("toTurn patches", () => {
  const before = lines(120);
  const after = lines(120, { 5: "changed five", 110: "changed one-ten" });
  const unit = unitOf([{ path: "src/a.ts", before: image(before), after: image(after) }]);

  test("emits a git-style unified patch headed with a/ and b/ paths", () => {
    const [file] = toTurn(unit).files;

    expect(file?.path).toBe("src/a.ts");
    expect(file?.patch.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@ ")).toBe(true);
    expect(file?.patch).toContain("-line 5\n+changed five\n");
    expect(file?.patch).not.toContain("=====");
  });

  test("a small patch is one WHOLE slice in the core planner", () => {
    const slices = planned(toTurn(unit), DEFAULT_EVIDENCE_POLICY.maxDiffLength);

    expect(slices).toHaveLength(1);
    expect(slices[0]?.kind).toBe("WHOLE");
  });

  test("an oversized patch is sliced by hunk with the file preamble", () => {
    const turn = toTurn(unit);
    const full = turn.files[0]?.patch ?? "";
    const slices = planned(turn, full.length - 1);

    expect(slices.map((slice) => slice.kind)).toEqual(["HUNK", "HUNK"]);
    expect(slices.map((slice) => slice.hunkOrdinal)).toEqual([0, 1]);
    expect(
      slices.every((slice) => slice.diff.startsWith("--- a/src/a.ts\n+++ b/src/a.ts\n@@ ")),
    ).toBe(true);
    expect(slices[0]?.diff).toContain("+changed five");
    expect(slices[1]?.diff).toContain("+changed one-ten");
  });

  test("new and deleted files use /dev/null for the absent side", () => {
    const created = toTurn(
      unitOf([{ path: "src/n.ts", before: image(null), after: image("x\n") }]),
    );
    const removed = toTurn(
      unitOf([{ path: "src/d.ts", before: image("x\n"), after: image(null) }]),
    );

    expect(created.files[0]?.patch.startsWith("--- /dev/null\n+++ b/src/n.ts\n@@ ")).toBe(true);
    expect(removed.files[0]?.patch.startsWith("--- a/src/d.ts\n+++ /dev/null\n@@ ")).toBe(true);
  });

  test("files without a net change are left out", () => {
    const turn = toTurn(
      unitOf([
        { path: "src/same.ts", before: image("x\n"), after: image("x\n") },
        { path: "src/gone.ts", before: image(null), after: image(null) },
        { path: "src/real.ts", before: image("a\n"), after: image("b\n") },
      ]),
    );

    expect(turn.files.map((file) => file.path)).toEqual(["src/real.ts"]);
  });
});

describe("toTurn task and id", () => {
  test("one prompt is the task verbatim", () => {
    expect(encodeTask(["  keep\nwhitespace  "])).toBe("  keep\nwhitespace  ");
  });

  test("two prompts keep order and full content", () => {
    const first = `first ${"x".repeat(5000)}\nline`;
    const second = "second\n\nwith blank line";
    const task = encodeTask([first, second]);

    expect(task).toBe(`Prompt 1 of 2:\n${first}\n\nPrompt 2 of 2:\n${second}`);
    expect(task.indexOf(first)).toBeLessThan(task.indexOf(second));
  });

  test("ids come from the session and ordinal only and are stable", () => {
    const a = unitOf([], ["x"]);
    const b = { ...unitOf([], ["y"]), ordinal: 1 };

    expect(turnId(a)).toBe("claude-code:s1:0");
    expect(turnId(a)).toBe(turnId(unitOf([], ["different"])));
    expect(turnId(b)).toBe("claude-code:s1:1");
    expect(toTurn(a).id).toBe("claude-code:s1:0");
  });

  test("a two-prompt acquired unit produces the full task", () => {
    const unit = new Scenario()
      .prompt("first")
      .tool("AGENT", "Agent")
      .stop("ACTIVE")
      .edit("src/a.ts", "a\n", "b\n", { agent: "sub1" })
      .prompt("second")
      .stop()
      .ready();

    expect(toTurn(unit).task).toBe("Prompt 1 of 2:\nfirst\n\nPrompt 2 of 2:\nsecond");
  });
});

describe("resolveAcquisition", () => {
  test("READY with a net patch is a TURN", () => {
    const result = resolveAcquisition(
      new Scenario().prompt().edit("src/a.ts", "a\n", "b\n").stop().acquire(),
    );

    expect(result.status).toBe("TURN");
  });

  test("SKIPPED stays SKIPPED/NO_ATTRIBUTED_PATCH", () => {
    const result = resolveAcquisition(new Scenario().prompt().stop().acquire());

    expect(result).toEqual({ status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" });
  });

  test("UNAVAILABLE maps a blocked path to BLOCKED_EVIDENCE", () => {
    const result = resolveAcquisition(
      new Scenario().prompt().edit(".env", "a", "b").stop().acquire(),
    );

    expect(result).toEqual({
      status: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
      causes: ["BLOCKED_PATH"],
    });
  });

  test("any other UNAVAILABLE cause maps to MISSING_ATTRIBUTED_DIFF and keeps the causes", () => {
    const result = resolveAcquisition(
      new Scenario().prompt().powershell().tool("MCP", "mcp__a__b").stop().acquire(),
    );

    expect(result).toEqual({
      status: "UNAVAILABLE",
      reason: "MISSING_ATTRIBUTED_DIFF",
      causes: ["SHELL_GIT_DIFF_UNAVAILABLE", "MCP_TOOL"],
    });
  });

  test("a blocked path wins over other causes", () => {
    const result = resolveAcquisition(
      new Scenario()
        .prompt()
        .edit(".env", "a", "b")
        .tool("MCP", "mcp__a__b")
        .stopFailure()
        .acquire(),
    );

    expect(result).toMatchObject({ reason: "BLOCKED_EVIDENCE" });
  });
});
