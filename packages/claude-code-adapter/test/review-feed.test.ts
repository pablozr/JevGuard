import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregateReview } from "@jevguard/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ClaudeReviewHandoff } from "../src/hook";
import { parseReviewFeed } from "../src/presentation";
import { createNodeReviewFeed, createNodeWorkerFileSystem } from "../src/worker";
import { backdate } from "./hook-world";

const NOW = new Date("2026-10-05T12:00:00.000Z");

let dataHome = "";

beforeEach(() => {
  dataHome = mkdtempSync(join(tmpdir(), "jevguard-review-feed-"));
});

afterEach(() => {
  rmSync(dataHome, { recursive: true, force: true });
});

function feedFor(variables: Record<string, string>) {
  return createNodeReviewFeed(
    { get: (name) => variables[name] },
    () => NOW,
    createNodeWorkerFileSystem(),
  );
}

function handoff(sessionId: string, resolution: ClaudeReviewHandoff["resolution"]) {
  const value: ClaudeReviewHandoff = {
    version: 1,
    turnId: `claude-code:${sessionId}:e:2`,
    sessionId,
    ordinal: 2,
    projectRoot: "/project",
    closedAt: NOW.toISOString(),
    shellCoverage: [],
    epoch: "e",
    resolution,
  };

  return value;
}

const unavailable: ClaudeReviewHandoff["resolution"] = {
  status: "UNAVAILABLE",
  reason: "MISSING_ATTRIBUTED_DIFF",
  causes: ["SHELL_BACKGROUND"],
};

const review = aggregateReview("claude-code:sess1:e:2", [
  {
    kind: "REVIEW",
    turnId: "claude-code:sess1:e:2",
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason: "MISSING_ATTRIBUTED_DIFF",
  },
]);

describe("createNodeReviewFeed", () => {
  test("appends STARTED and RECORDED lines to the session file under XDG_DATA_HOME", () => {
    const feed = feedFor({ XDG_DATA_HOME: dataHome });
    const value = handoff("sess1", unavailable);

    feed.started(value);
    feed.recorded(value, review, false);

    const file = join(dataHome, "jevguard", "claude-code", "feed", "sess1.jsonl");
    const lines = parseReviewFeed(readFileSync(file, "utf8"));

    expect(lines.map((line) => line.kind)).toEqual(["STARTED", "RECORDED"]);
    expect(lines[1]).toMatchObject({
      turnId: "claude-code:sess1:e:2",
      at: NOW.toISOString(),
      causes: ["SHELL_BACKGROUND"],
      counts: { unavailable: 1 },
    });
  });

  test("a unit that was not unavailable carries no causes", () => {
    const feed = feedFor({ XDG_DATA_HOME: dataHome });

    feed.recorded(
      handoff("sess1", { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" }),
      review,
      false,
    );

    const file = join(dataHome, "jevguard", "claude-code", "feed", "sess1.jsonl");
    const [line] = parseReviewFeed(readFileSync(file, "utf8"));

    expect(line).toMatchObject({ kind: "RECORDED", causes: [] });
  });

  test("an unsafe session id or an empty environment writes nothing", () => {
    feedFor({ XDG_DATA_HOME: dataHome }).started(handoff("../escape", unavailable));
    feedFor({}).started(handoff("sess1", unavailable));

    expect(existsSync(join(dataHome, "jevguard"))).toBe(false);
  });

  test("sweep deletes a feed untouched for over 24 hours and keeps a recent one", () => {
    const directory = join(dataHome, "jevguard", "claude-code", "feed");
    const old = join(directory, "old.jsonl");
    const recent = join(directory, "recent.jsonl");
    const other = join(directory, "notes.txt");

    mkdirSync(directory, { recursive: true });

    for (const file of [old, recent, other]) writeFileSync(file, "{}\n");

    backdate(old, 25, NOW);
    backdate(other, 25, NOW);
    backdate(recent, 0, NOW);
    feedFor({ XDG_DATA_HOME: dataHome }).sweep();

    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  test("sweep without a feed directory does nothing", () => {
    expect(() => feedFor({ XDG_DATA_HOME: dataHome }).sweep()).not.toThrow();
    expect(() => feedFor({}).sweep()).not.toThrow();
  });
});
