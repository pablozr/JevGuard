import { describe, expect, test } from "vitest";
import { acquireUnit, resolveAcquisition, splitQuiescentUnits } from "../src/index";
import {
  cleanChange,
  dirtyChange,
  git,
  image,
  reasonsOf,
  resolveRepoPath,
  Scenario,
  unreadChange,
} from "./scenario";

function scenario(): Scenario {
  return new Scenario().prompt();
}

describe("acquireUnit universe and shell rules", () => {
  test("edit-only is READY with the pre and final images", () => {
    const result = scenario().edit("src/a.ts", "old\n", "new\n").stop().acquire();

    expect(result).toEqual({
      status: "READY",
      unit: {
        sessionId: "s1",
        ordinal: 0,
        prompts: ["do the task"],
        files: [{ path: "src/a.ts", before: image("old\n"), after: image("new\n") }],
      },
    });
  });

  test("several edits of one file keep the first pre-image and the last final image", () => {
    const unit = scenario()
      .edit("src/a.ts", "v0", "v1")
      .edit("src/a.ts", "v1", "v2")
      .stop()
      .ready();

    expect(unit.files).toEqual([{ path: "src/a.ts", before: image("v0"), after: image("v2") }]);
  });

  test("edit plus a shell with an empty Git diff is READY", () => {
    const result = scenario().edit("src/a.ts", "a", "b").bash({ git: git() }).stop().acquire();

    expect(result.status).toBe("READY");
  });

  test("a clean Bash change outside the universe is READY with the file in the patch", () => {
    const result = scenario()
      .bash({ git: git(cleanChange("src/x.ts", "indexed", "changed")) })
      .stop()
      .acquire();

    expect(result).toMatchObject({
      status: "READY",
      unit: { files: [{ path: "src/x.ts", before: image("indexed"), after: image("changed") }] },
    });
  });

  test("a clean Bash change to a new file has an absent pre-image", () => {
    const result = scenario()
      .bash({ git: git(cleanChange("src/new.ts", null, "fresh")) })
      .stop()
      .acquire();

    expect(result).toMatchObject({
      status: "READY",
      unit: { files: [{ path: "src/new.ts", before: image(null), after: image("fresh") }] },
    });
  });

  test("a dirty Bash change outside the universe is unavailable", () => {
    const result = scenario()
      .bash({ git: git(dirtyChange("src/x.ts", "changed")) })
      .stop()
      .acquire();

    expect(reasonsOf(result)).toEqual(["SHELL_CHANGED_OUTSIDE_UNIVERSE"]);
  });

  test("a Bash change to a file edited later was outside the universe", () => {
    const result = scenario()
      .bash({ git: git(dirtyChange("src/a.ts", "x")) })
      .edit("src/a.ts", "a", "b")
      .stop()
      .acquire();

    expect(reasonsOf(result)).toEqual(["SHELL_CHANGED_OUTSIDE_UNIVERSE"]);
  });

  test("a blocked Bash change is BLOCKED_PATH", () => {
    const result = scenario()
      .bash({ git: git(cleanChange(".env", "A=1", "A=2")) })
      .stop()
      .acquire();

    expect(reasonsOf(result)).toEqual(["BLOCKED_PATH"]);
  });

  test("Bash without a Git diff is SHELL_GIT_DIFF_UNAVAILABLE", () => {
    const missing = scenario().bash().stop().acquire();
    const failed = scenario()
      .bash({ git: { status: "FAILED" } })
      .stop()
      .acquire();

    expect(reasonsOf(missing)).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
    expect(reasonsOf(failed)).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });

  test("a failed Bash with a Git diff is not a reason", () => {
    const result = scenario()
      .bash({ failed: true, git: git(cleanChange("src/x.ts", "indexed", "changed")) })
      .stop()
      .acquire();

    expect(result.status).toBe("READY");
  });

  test("a failed Bash without a Git diff is SHELL_GIT_DIFF_UNAVAILABLE", () => {
    const result = scenario().bash({ failed: true }).stop().acquire();

    expect(reasonsOf(result)).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });

  test("the host bashEditDiff never influences acquisition", () => {
    const disagree = scenario()
      .bash({
        git: git(cleanChange("src/x.ts", "indexed", "changed")),
        shellDiff: { status: "PRESENT", changedFiles: ["/repo/src/other.ts"] },
      })
      .stop()
      .acquire();
    const incomplete = scenario()
      .bash({ git: git(), shellDiff: { status: "INCOMPLETE" } })
      .stop()
      .acquire();
    const withoutGit = scenario()
      .bash({ shellDiff: { status: "PRESENT", changedFiles: [] } })
      .stop()
      .acquire();

    expect(disagree).toMatchObject({ status: "READY" });
    expect(incomplete).toEqual({ status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" });
    expect(reasonsOf(withoutGit)).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });

  test("a file brought in from the index is in the universe for later shells", () => {
    const result = scenario()
      .bash({ git: git(cleanChange("src/x.ts", "indexed", "one")) })
      .bash({ git: git(dirtyChange("src/x.ts", "two")) })
      .stop()
      .acquire();

    expect(result).toMatchObject({
      status: "READY",
      unit: { files: [{ path: "src/x.ts", before: image("indexed"), after: image("two") }] },
    });
  });

  test("a later edit of a file brought in from the index keeps the index pre-image", () => {
    const result = scenario()
      .powershell({ git: git(cleanChange("src/x.ts", "indexed", "one")) })
      .edit("src/x.ts", "one", "two")
      .stop()
      .acquire();

    expect(result).toMatchObject({
      status: "READY",
      unit: { files: [{ path: "src/x.ts", before: image("indexed"), after: image("two") }] },
    });
  });

  test("background Bash is SHELL_BACKGROUND with or without a diff", () => {
    const bare = scenario().bash({ background: true }).stop().acquire();
    const withDiff = scenario().bash({ background: true, git: git() }).stop().acquire();

    expect(reasonsOf(bare)).toEqual(["SHELL_BACKGROUND"]);
    expect(reasonsOf(withDiff)).toEqual(["SHELL_BACKGROUND"]);
  });

  test("a subagent edit joins the universe", () => {
    const result = scenario().edit("src/a.ts", "a", "b", { agent: "sub1" }).stop().acquire();

    expect(result.status).toBe("READY");
  });

  test("subagent MCP and PowerShell follow the main rules", () => {
    const mcp = scenario().tool("MCP", "mcp__x__y", { agent: "sub1" }).stop().acquire();
    const shell = scenario().powershell({ agent: "sub1" }).stop().acquire();

    expect(reasonsOf(mcp)).toEqual(["MCP_TOOL"]);
    expect(reasonsOf(shell)).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });

  test("coordination and read-only tools do not affect the unit", () => {
    const result = scenario()
      .tool("COORDINATION", "SendMessage")
      .tool("COORDINATION", "Skill")
      .tool("COORDINATION", "SubagentHandback")
      .tool("READONLY", "Read")
      .tool("AGENT", "Agent")
      .stop()
      .acquire();

    expect(result).toEqual({ status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" });
  });

  test("MCP and unknown tools are unavailable", () => {
    expect(reasonsOf(scenario().tool("MCP", "mcp__a__b").stop().acquire())).toEqual(["MCP_TOOL"]);
    expect(reasonsOf(scenario().tool("UNKNOWN", "Weird").stop().acquire())).toEqual([
      "UNKNOWN_TOOL",
    ]);
  });
});

describe("acquireUnit shell via Git diff", () => {
  test("no Git diff or a failed one is SHELL_GIT_DIFF_UNAVAILABLE", () => {
    const missing = scenario().powershell().stop().acquire();
    const failed = scenario()
      .powershell({ git: { status: "FAILED" } })
      .stop()
      .acquire();

    expect(reasonsOf(missing)).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
    expect(reasonsOf(failed)).toEqual(["SHELL_GIT_DIFF_UNAVAILABLE"]);
  });

  test("a clean Git diff plus an edit is READY", () => {
    const result = scenario()
      .edit("src/a.ts", "a", "b")
      .powershell({ git: git() })
      .stop()
      .acquire();

    expect(result.status).toBe("READY");
  });

  test("a clean file changed outside the universe is recovered from the index", () => {
    const result = scenario()
      .powershell({ git: git(cleanChange("src/x.ts", "indexed", "changed")) })
      .stop()
      .acquire();

    expect(result).toMatchObject({
      status: "READY",
      unit: { files: [{ path: "src/x.ts", before: image("indexed"), after: image("changed") }] },
    });
  });

  test("a dirty file changed outside the universe is unavailable", () => {
    const result = scenario()
      .powershell({ git: git(dirtyChange("src/x.ts", "changed")) })
      .stop()
      .acquire();

    expect(reasonsOf(result)).toEqual(["SHELL_CHANGED_OUTSIDE_UNIVERSE"]);
  });

  test("a dirty file already edited is fine", () => {
    const result = scenario()
      .edit("src/x.ts", "a", "b")
      .powershell({ git: git(dirtyChange("src/x.ts", "c")) })
      .stop()
      .acquire();

    expect(result).toMatchObject({
      status: "READY",
      unit: { files: [{ path: "src/x.ts", before: image("a"), after: image("c") }] },
    });
  });

  test("a blocked changed path is BLOCKED_PATH", () => {
    const result = scenario()
      .powershell({ git: git(cleanChange(".env", "A=1", "A=2")) })
      .stop()
      .acquire();

    expect(reasonsOf(result)).toEqual(["BLOCKED_PATH"]);
  });
});

describe("acquireUnit path safety", () => {
  test("a blocked edit is BLOCKED_PATH and its capture is never read", () => {
    const run = scenario().edit(".env", "A=1", "A=2");
    const result = run.stop().acquire();

    expect(reasonsOf(result)).toEqual(["BLOCKED_PATH"]);
    expect(run.reads).not.toContain(".env");
  });

  test("a subagent edit of a blocked path is BLOCKED_PATH", () => {
    const result = scenario().edit(".env", "a", "b", { agent: "sub1" }).stop().acquire();

    expect(reasonsOf(result)).toEqual(["BLOCKED_PATH"]);
  });

  test("a non-allowlisted extension and a denied directory are blocked", () => {
    expect(reasonsOf(scenario().edit("blob.bin", "a", "b").stop().acquire())).toEqual([
      "BLOCKED_PATH",
    ]);
    expect(reasonsOf(scenario().edit(".ssh/x.ts", "a", "b").stop().acquire())).toEqual([
      "BLOCKED_PATH",
    ]);
  });

  test("an edit without a path or outside the repository is unavailable", () => {
    const missing = scenario().editWithoutPath().stop().acquire();
    const outside = scenario()
      .push({
        sessionId: "s1",
        cwd: "/repo",
        promptId: null,
        agentId: null,
        name: "PreToolUse",
        tool: {
          toolName: "Write",
          category: "EDIT",
          toolUseId: "z",
          filePath: "/other/a.ts",
          runInBackground: false,
        },
      })
      .stop()
      .acquire();

    expect(reasonsOf(missing)).toContain("MISSING_PATH");
    expect(reasonsOf(outside)).toContain("PATH_OUTSIDE_REPOSITORY");
  });
});

describe("acquireUnit pairing and failures", () => {
  test("a Pre without a Post is PAIRING_BROKEN", () => {
    const run = scenario().edit("src/a.ts", "a", "b");
    const events = run.events.filter((event) => event.name !== "PostToolUse");
    const unit = splitQuiescentUnits([...events, ...new Scenario().stop().events]).closed[0];

    expect(unit).toBeDefined();
    if (unit === undefined) return;

    const result = acquireUnit({ unit, capture: run.capture(), resolveRepoPath });

    expect(reasonsOf(result)).toContain("PAIRING_BROKEN");
  });

  test("a Post without its Pre is PAIRING_BROKEN", () => {
    const run = scenario().bash();
    const events = run.events.filter((event) => event.name !== "PreToolUse");
    const unit = splitQuiescentUnits([...events, ...new Scenario().stop().events]).closed[0];

    if (unit === undefined) throw new Error("unit did not close");

    const result = acquireUnit({ unit, capture: run.capture(), resolveRepoPath });

    expect(reasonsOf(result)).toContain("PAIRING_BROKEN");
  });

  test("a failed edit that left the file untouched is not a reason", () => {
    const run = scenario().edit("src/a.ts", "a", "b").overrideFinal("src/a.ts", "a");
    const post = run.events.pop();

    if (post?.name !== "PostToolUse") throw new Error("expected a PostToolUse");

    run.push({ ...post, name: "PostToolUseFailure" });

    expect(reasonsOf(run.stop().acquire())).toEqual([]);
  });

  test("a failed edit that changed the file anyway is UNATTRIBUTED_WRITER", () => {
    const run = scenario().edit("src/a.ts", "a", "b");
    const post = run.events.pop();

    if (post?.name !== "PostToolUse") throw new Error("expected a PostToolUse");

    run.push({ ...post, name: "PostToolUseFailure" });

    expect(reasonsOf(run.stop().acquire())).toEqual(["UNATTRIBUTED_WRITER"]);
  });
});

describe("acquireUnit closure", () => {
  test("StopFailure closes the unit as TURN_FAILED", () => {
    const result = scenario().edit("src/a.ts", "a", "b").stopFailure().acquire();

    expect(reasonsOf(result)).toEqual(["TURN_FAILED"]);
  });

  test("a Stop without readable background_tasks is BACKGROUND_STATE_UNKNOWN", () => {
    const result = scenario().edit("src/a.ts", "a", "b").stop("UNKNOWN").acquire();

    expect(reasonsOf(result)).toEqual(["BACKGROUND_STATE_UNKNOWN"]);
  });

  test("a unit without a prompt is MISSING_PROMPT and a non-text prompt is PROMPT_NOT_TEXT", () => {
    expect(reasonsOf(new Scenario().stop().acquire())).toEqual(["MISSING_PROMPT"]);
    expect(reasonsOf(new Scenario().prompt().rawPrompt(null).stop().acquire())).toEqual([
      "PROMPT_NOT_TEXT",
    ]);
  });

  test("an active Stop does not close; the later empty Stop closes the same unit", () => {
    const run = scenario()
      .tool("AGENT", "Agent")
      .stop("ACTIVE")
      .edit("src/a.ts", "a", "b", { agent: "sub1" })
      .prompt("follow up")
      .stop("EMPTY");
    const split = splitQuiescentUnits(run.events);
    const result = run.acquire();

    expect(split.closed).toHaveLength(1);
    expect(split.open).toEqual([]);
    expect(result).toMatchObject({
      status: "READY",
      unit: { prompts: ["do the task", "follow up"], files: [{ path: "src/a.ts" }] },
    });
  });

  test("an async subagent editing after a closing Stop belongs to the next unit", () => {
    const run = scenario()
      .stop("EMPTY")
      .edit("src/late.ts", "a", "b", { agent: "sub1" })
      .prompt("next")
      .stop();
    const split = splitQuiescentUnits(run.events);

    expect(split.closed.map((unit) => unit.ordinal)).toEqual([0, 1]);
    expect(run.acquire(0)).toEqual({ status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" });
    expect(run.acquire(1).status).toBe("READY");
  });

  test("a subagent Stop never closes the unit and an unclosed unit stays open", () => {
    const run = scenario().stop("EMPTY", "sub1").edit("src/a.ts", "a", "b");
    const split = splitQuiescentUnits(run.events);

    expect(split.closed).toEqual([]);
    expect(split.open.some((event) => event.name === "UserPromptSubmit")).toBe(true);
  });

  test("an active Stop alone leaves the unit open", () => {
    const split = splitQuiescentUnits(scenario().edit("src/a.ts", "a", "b").stop("ACTIVE").events);

    expect(split.closed).toEqual([]);
    expect(split.open.length).toBeGreaterThan(0);
  });

  test("reasons accumulate in a stable order", () => {
    const result = scenario()
      .edit(".env", "a", "b")
      .tool("MCP", "mcp__a__b")
      .powershell()
      .stopFailure()
      .acquire();

    expect(reasonsOf(result)).toEqual([
      "TURN_FAILED",
      "BLOCKED_PATH",
      "SHELL_GIT_DIFF_UNAVAILABLE",
      "MCP_TOOL",
    ]);
  });
});

describe("acquireUnit continuity", () => {
  test("a final image differing from the last attributed post is UNATTRIBUTED_WRITER", () => {
    const result = scenario()
      .edit("src/a.ts", "a", "b")
      .overrideFinal("src/a.ts", "tampered")
      .stop()
      .acquire();

    expect(reasonsOf(result)).toEqual(["UNATTRIBUTED_WRITER"]);
  });

  test("a final image deleted behind the agent is UNATTRIBUTED_WRITER", () => {
    const result = scenario()
      .edit("src/a.ts", "a", "b")
      .overrideFinal("src/a.ts", null)
      .stop()
      .acquire();

    expect(reasonsOf(result)).toEqual(["UNATTRIBUTED_WRITER"]);
  });

  test("a missing capture is MISSING_CAPTURE", () => {
    const run = scenario().edit("src/a.ts", "a", "b").stop();
    const { closed } = splitQuiescentUnits(run.events);
    const unit = closed[0];

    if (unit === undefined) throw new Error("unit did not close");

    const capture = { ...run.capture(), finalImages: new Map() };
    const result = acquireUnit({ unit, capture, resolveRepoPath });

    expect(reasonsOf(result)).toEqual(["MISSING_CAPTURE"]);
  });

  test("write then revert is READY here and SKIPPED once resolved", () => {
    const result = scenario()
      .edit("src/a.ts", "a", "b")
      .edit("src/a.ts", "b", "a")
      .stop()
      .acquire();

    expect(result.status).toBe("READY");
    expect(resolveAcquisition(result)).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });
});

describe("acquireUnit capture-fed rules", () => {
  test("an unread blocked PowerShell change is BLOCKED_PATH, an unread allowed one MISSING_CAPTURE", () => {
    const blocked = scenario()
      .powershell({ git: git(unreadChange(".env")) })
      .stop()
      .acquire();
    const allowed = scenario()
      .powershell({ git: git(unreadChange("src/x.ts")) })
      .stop()
      .acquire();

    expect(reasonsOf(blocked)).toEqual(["BLOCKED_PATH"]);
    expect(reasonsOf(allowed)).toEqual(["MISSING_CAPTURE"]);
  });

  test.each(["CAPTURE_FAILED", "CONTENT_TOO_LARGE", "CONTENT_NOT_TEXT"] as const)(
    "the %s problem becomes an acquisition reason",
    (problem) => {
      const result = scenario().edit("src/a.ts", "a", "b").problem(problem).stop().acquire();

      expect(reasonsOf(result)).toEqual([problem]);
    },
  );
});
