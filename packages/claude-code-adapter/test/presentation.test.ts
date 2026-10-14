import type { ReviewCounts, TurnReview } from "@jevguard/core";
import { describe, expect, test } from "vitest";
import type { FeedEnvironment, ReviewFeedRecorded, ReviewFeedResult } from "../src/presentation";
import {
  armWatch,
  baselineWatch,
  describeReview,
  displayOutcomeOf,
  emptyWatch,
  PENDING_MAX_MS,
  parseReviewFeed,
  reviewFeedDirectoryOf,
  reviewFeedFileOf,
  tickWatch,
  toFeedRecorded,
  toFeedStarted,
  unitLabelOf,
  WATCH_CEILING_MS,
  WATCH_WINDOW_MS,
} from "../src/presentation";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const SESSION = "s";

function environment(overrides: Partial<FeedEnvironment> = {}): FeedEnvironment {
  return { xdgDataHome: undefined, userProfile: undefined, home: undefined, ...overrides };
}

function counts(overrides: Partial<ReviewCounts> = {}): ReviewCounts {
  return { pass: 0, warn: 0, fail: 0, skipped: 0, unavailable: 0, ...overrides };
}

function semantic(
  id: string,
  outcome: "PASS" | "WARN" | "FAIL",
  probability: number,
  lane: ReviewFeedResult["lane"] = "RULE",
): ReviewFeedResult {
  return { lane, id, sliceCount: null, outcome, probability };
}

function operational(
  id: string | null,
  outcome: "SKIPPED" | "UNAVAILABLE",
  reason: string,
  lane: ReviewFeedResult["lane"] = "RULE",
): ReviewFeedResult {
  return { lane, id, sliceCount: null, outcome, reason };
}

function recorded(
  ordinal: number,
  summary: Partial<ReviewCounts>,
  results: readonly ReviewFeedResult[],
  causes: readonly string[] = [],
  session = SESSION,
): ReviewFeedRecorded {
  return {
    v: 1,
    kind: "RECORDED",
    turnId: `claude-code:${session}:e:${ordinal}`,
    at: new Date(T0).toISOString(),
    counts: counts(summary),
    causes,
    results,
  };
}

function started(ordinal: number, atMs: number, session = SESSION) {
  return toFeedStarted(`claude-code:${session}:e:${ordinal}`, new Date(atMs).toISOString());
}

describe("review feed path", () => {
  test("prefers an absolute XDG_DATA_HOME", () => {
    expect(reviewFeedDirectoryOf(environment({ xdgDataHome: "/data/", home: "/home/u" }))).toBe(
      "/data/jevguard/claude-code/feed",
    );
  });

  test("ignores a relative XDG_DATA_HOME and falls back to the home directory", () => {
    expect(reviewFeedDirectoryOf(environment({ xdgDataHome: "data", home: "/home/u" }))).toBe(
      "/home/u/.local/share/jevguard/claude-code/feed",
    );
  });

  test("uses USERPROFILE before HOME and strips trailing separators", () => {
    expect(
      reviewFeedDirectoryOf(environment({ userProfile: "C:\\Users\\u\\", home: "/home/u" })),
    ).toBe("C:\\Users\\u/.local/share/jevguard/claude-code/feed");
  });

  test("an empty USERPROFILE falls through to HOME", () => {
    expect(reviewFeedDirectoryOf(environment({ userProfile: "", home: "/home/u" }))).toBe(
      "/home/u/.local/share/jevguard/claude-code/feed",
    );
  });

  test("has no location without an absolute base", () => {
    expect(reviewFeedDirectoryOf(environment())).toBeNull();
    expect(reviewFeedDirectoryOf(environment({ home: "relative" }))).toBeNull();
    expect(reviewFeedFileOf(environment(), SESSION)).toBeNull();
  });

  test("builds the session file and refuses an unsafe session id", () => {
    const env = environment({ xdgDataHome: "/data" });

    expect(reviewFeedFileOf(env, "abc-123_X")).toBe(
      "/data/jevguard/claude-code/feed/abc-123_X.jsonl",
    );
    expect(reviewFeedFileOf(env, "../escape")).toBeNull();
    expect(reviewFeedFileOf(env, "a b")).toBeNull();
    expect(reviewFeedFileOf(env, "")).toBeNull();
    expect(reviewFeedFileOf(env, "a".repeat(129))).toBeNull();
  });
});

describe("parseReviewFeed", () => {
  const valid = JSON.stringify(recorded(1, { pass: 1 }, [semantic("R-1", "PASS", 0.1)]));

  test("drops a partial last line and invalid JSON, keeping valid lines", () => {
    const text = `${valid}\nnot json\n${valid.slice(0, 40)}`;

    expect(parseReviewFeed(text)).toHaveLength(1);
  });

  test("rejects ids with whitespace or control characters", () => {
    for (const id of ["A B", "A\u001b[31m"]) {
      const line = JSON.stringify(recorded(1, { pass: 1 }, [semantic(id, "PASS", 0.1)]));

      expect(parseReviewFeed(line)).toEqual([]);
    }
  });

  test("rejects an out-of-range probability, a lowercase reason and a foreign turn id", () => {
    const high = recorded(1, { fail: 1 }, [semantic("R-1", "FAIL", 1.2)]);
    const lower = recorded(1, { unavailable: 1 }, [
      operational("R-1", "UNAVAILABLE", "bad_reason"),
    ]);
    const foreign = { ...recorded(1, { pass: 1 }, []), turnId: "other:s:e:1" };

    for (const line of [high, lower, foreign]) {
      expect(parseReviewFeed(JSON.stringify(line))).toEqual([]);
    }
  });

  test("rejects negative or fractional counts and a wrong version", () => {
    const negative = recorded(1, { pass: -1 }, []);
    const fractional = recorded(1, { pass: 1.5 }, []);
    const version = { ...recorded(1, { pass: 1 }, []), v: 2 };

    for (const line of [negative, fractional, version]) {
      expect(parseReviewFeed(JSON.stringify(line))).toEqual([]);
    }
  });

  test("round-trips a projected review without paths or severities", () => {
    const review: TurnReview = {
      turnId: "claude-code:s:e:3",
      results: [
        {
          kind: "RULE",
          turnId: "claude-code:s:e:3",
          ruleId: "ARCH-001",
          severity: "error",
          scopedPaths: ["src/secret-path.ts"],
          outcome: "FAIL",
          violationProbability: 0.91,
          evidence: {
            mode: "SLICED",
            plannedSliceCount: 3,
            evaluatedSliceCount: 3,
            failedSliceCount: 0,
            notEvaluatedSliceCount: 0,
            slices: [],
            sliceJudgments: [],
            failingSliceIndex: null,
            failureReason: null,
          },
        },
        {
          kind: "BUILT_IN",
          turnId: "claude-code:s:e:3",
          ruleId: null,
          checkId: "COMPLEXITY",
          severity: "warning",
          scopedPaths: [],
          outcome: "UNAVAILABLE",
          reason: "JEV_FAILURE",
        },
        {
          kind: "REVIEW",
          turnId: "claude-code:s:e:3",
          ruleId: null,
          severity: null,
          scopedPaths: [],
          outcome: "SKIPPED",
          reason: "NO_ATTRIBUTED_PATCH",
        },
      ],
      summary: {
        verdict: "FAIL",
        hasUnavailable: true,
        counts: counts({ fail: 1, unavailable: 1, skipped: 1 }),
      },
    };
    const line = JSON.stringify(
      toFeedRecorded(review, ["SHELL_BACKGROUND"], "2026-10-05T12:00:00.000Z"),
    );

    expect(line).not.toContain("secret-path");
    expect(line).not.toContain("severity");
    expect(parseReviewFeed(line)).toEqual([
      {
        v: 1,
        kind: "RECORDED",
        turnId: "claude-code:s:e:3",
        at: "2026-10-05T12:00:00.000Z",
        counts: counts({ fail: 1, unavailable: 1, skipped: 1 }),
        causes: ["SHELL_BACKGROUND"],
        results: [
          { lane: "RULE", id: "ARCH-001", sliceCount: 3, outcome: "FAIL", probability: 0.91 },
          {
            lane: "BUILT_IN",
            id: "COMPLEXITY",
            sliceCount: null,
            outcome: "UNAVAILABLE",
            reason: "JEV_FAILURE",
          },
          {
            lane: "REVIEW",
            id: null,
            sliceCount: null,
            outcome: "SKIPPED",
            reason: "NO_ATTRIBUTED_PATCH",
          },
        ],
      },
    ]);
  });

  test("parses STARTED lines", () => {
    const line = JSON.stringify(started(1, T0));

    expect(parseReviewFeed(line)).toEqual([started(1, T0)]);
  });
});

describe("describeReview", () => {
  test("PASS", () => {
    const display = describeReview(recorded(2, { pass: 3, skipped: 1 }, []));

    expect(display.line).toBe("JevGuard PASS · unit 2 · pass 3 · skipped 1");
    expect(display.status).toBe("JevGuard PASS · unit 2 · 3 pass");
    expect(display.toast).toBeNull();
  });

  test("WARN", () => {
    const display = describeReview(
      recorded(3, { warn: 1, pass: 3 }, [semantic("TEST-001", "WARN", 0.47)]),
    );

    expect(display.line).toBe("JevGuard WARN · unit 3 · warn: TEST-001 47% · pass 3");
    expect(display.toast).toBeNull();
  });

  test("FAIL", () => {
    const display = describeReview(
      recorded(4, { fail: 1, warn: 1, pass: 2 }, [
        semantic("ARCH-001", "FAIL", 0.914),
        semantic("SCOPE-CREEP", "WARN", 0.52, "BUILT_IN"),
      ]),
    );

    expect(display.line).toBe(
      "JevGuard FAIL · unit 4 · fail: ARCH-001 91% · warn: SCOPE-CREEP 52% · pass 2",
    );
    expect(display.toast).toBe("JevGuard FAIL · unit 4 · ARCH-001");
    expect(display.status).toBe("JevGuard FAIL · unit 4 · 1 fail, 1 warn, 2 pass");
  });

  test("UNAVAILABLE from acquisition names the causes", () => {
    const display = describeReview(
      recorded(
        5,
        { unavailable: 1 },
        [operational(null, "UNAVAILABLE", "MISSING_ATTRIBUTED_DIFF", "REVIEW")],
        ["SHELL_BACKGROUND"],
      ),
    );

    expect(display.line).toBe(
      "JevGuard UNAVAILABLE · unit 5 · unavailable: review MISSING_ATTRIBUTED_DIFF (SHELL_BACKGROUND)",
    );
  });

  test("UNAVAILABLE per rule", () => {
    const display = describeReview(
      recorded(6, { unavailable: 2 }, [
        operational("ARCH-001", "UNAVAILABLE", "JEV_FAILURE"),
        operational("COMPLEXITY", "UNAVAILABLE", "JEV_FAILURE", "BUILT_IN"),
      ]),
    );

    expect(display.line).toBe(
      "JevGuard UNAVAILABLE · unit 6 · unavailable: ARCH-001 JEV_FAILURE, COMPLEXITY JEV_FAILURE",
    );
  });

  test("SKIPPED has no transcript line", () => {
    const display = describeReview(
      recorded(7, { skipped: 1 }, [operational(null, "SKIPPED", "NO_ATTRIBUTED_PATCH", "REVIEW")]),
    );

    expect(display.line).toBeNull();
    expect(display.status).toBe("JevGuard SKIPPED · unit 7 · no attributed changes");
  });

  test("SKIPPED by scope says no rule is in scope", () => {
    const display = describeReview(
      recorded(8, { skipped: 1 }, [operational("R-1", "SKIPPED", "NO_SCOPE_MATCH")]),
    );

    expect(display.status).toBe("JevGuard SKIPPED · unit 8 · no rule in scope");
  });

  test("caps listed ids and counts the rest", () => {
    const results = Array.from({ length: 7 }, (_, index) => semantic(`R-${index}`, "FAIL", 0.9));
    const display = describeReview(recorded(9, { fail: 7 }, results));

    expect(display.line).toBe(
      "JevGuard FAIL · unit 9 · fail: R-0 90%, R-1 90%, R-2 90%, R-3 90%, R-4 90%, +2 more",
    );
    expect(display.toast).toBe("JevGuard FAIL · unit 9 · R-0, R-1, R-2, R-3, R-4, +2 more");
  });

  test("shows the slice count above one", () => {
    const sliced: ReviewFeedResult = {
      lane: "RULE",
      id: "ARCH-001",
      sliceCount: 4,
      outcome: "FAIL",
      probability: 0.8,
    };

    expect(describeReview(recorded(1, { fail: 1 }, [sliced])).line).toContain(
      "ARCH-001 80% (4 slices)",
    );
  });

  test("rounds probabilities to whole percentages", () => {
    const percent = (probability: number) =>
      describeReview(recorded(1, { warn: 1 }, [semantic("R", "WARN", probability)])).line;

    expect(percent(0)).toContain("R 0%");
    expect(percent(0.5)).toContain("R 50%");
    expect(percent(0.914)).toContain("R 91%");
    expect(percent(1)).toContain("R 100%");
  });

  test("outcome precedence is FAIL, UNAVAILABLE, WARN, PASS, SKIPPED", () => {
    expect(displayOutcomeOf(counts({ fail: 1, unavailable: 1, warn: 1, pass: 1 }))).toBe("FAIL");
    expect(displayOutcomeOf(counts({ unavailable: 1, warn: 1, pass: 1 }))).toBe("UNAVAILABLE");
    expect(displayOutcomeOf(counts({ warn: 1, pass: 1 }))).toBe("WARN");
    expect(displayOutcomeOf(counts({ pass: 1, skipped: 1 }))).toBe("PASS");
    expect(displayOutcomeOf(counts({ skipped: 1 }))).toBe("SKIPPED");
  });

  test("unit label falls back when the id has no ordinal", () => {
    expect(unitLabelOf("claude-code:s:e:12")).toBe("unit 12");
    expect(unitLabelOf("claude-code:s:e:x")).toBe("unit");
  });
});

describe("feed watch", () => {
  test("a long session never shows an old review again, however many the feed holds", () => {
    const lines = Array.from({ length: 300 }, (_, index) => recorded(index + 1, { pass: 1 }, []));
    let watch = armWatch(baselineWatch(lines, SESSION, T0), T0);

    for (let step = 1; step <= 3; step += 1) {
      const tick = tickWatch(watch, lines, SESSION, T0 + step);

      expect(tick.displays).toEqual([]);
      watch = tick.watch;
    }

    const next = recorded(301, { fail: 1 }, [semantic("ARCH-001", "FAIL", 0.9)]);
    const tick = tickWatch(watch, [...lines.slice(1), next], SESSION, T0 + 4);

    expect(tick.displays.map((display) => display.unit)).toEqual(["unit 301"]);
  });

  test("baseline never replays recorded reviews and arms for a fresh pending one", () => {
    const lines = [recorded(1, { pass: 1 }, []), started(2, T0 - 1000)];
    const watch = baselineWatch(lines, SESSION, T0);

    expect(watch.armedAtMs).toBe(T0);

    const tick = tickWatch(watch, lines, SESSION, T0);

    expect(tick.displays).toEqual([]);
    expect(tick.status).toBe("JevGuard reviewing unit 2...");
  });

  test("baseline marks an old started line as seen and stays idle", () => {
    const lines = [started(1, T0 - PENDING_MAX_MS - 1)];
    const watch = baselineWatch(lines, SESSION, T0);

    expect(watch.armedAtMs).toBeNull();
    expect(tickWatch(armWatch(watch, T0), lines, SESSION, T0).status).toBeNull();
  });

  test("shows a recorded review exactly once", () => {
    const lines = [recorded(1, { pass: 2 }, [])];
    const armed = armWatch(emptyWatch(), T0);
    const first = tickWatch(armed, lines, SESSION, T0 + 1);
    const second = tickWatch(first.watch, [...lines, ...lines], SESSION, T0 + 2);

    expect(first.displays).toHaveLength(1);
    expect(first.status).toBe("JevGuard PASS · unit 1 · 2 pass");
    expect(second.displays).toEqual([]);
  });

  test("ignores another session", () => {
    const lines = [started(1, T0, "other"), recorded(1, { fail: 1 }, [], [], "other")];
    const tick = tickWatch(armWatch(emptyWatch(), T0), lines, SESSION, T0);

    expect(tick.displays).toEqual([]);
    expect(tick.status).toBeNull();
  });

  test("status moves from reviewing to the result", () => {
    const armed = armWatch(emptyWatch(), T0);
    const pending = tickWatch(armed, [started(1, T0)], SESSION, T0 + 1000);
    const done = tickWatch(
      pending.watch,
      [started(1, T0), recorded(1, { pass: 1 }, [])],
      SESSION,
      T0 + 2000,
    );

    expect(pending.status).toBe("JevGuard reviewing unit 1...");
    expect(done.status).toBe("JevGuard PASS · unit 1 · 1 pass");
  });

  test("keeps polling exactly through the watch window, then stops", () => {
    const armed = armWatch(emptyWatch(), T0);

    expect(tickWatch(armed, [], SESSION, T0 + WATCH_WINDOW_MS).stop).toBe(false);

    const stopped = tickWatch(armed, [], SESSION, T0 + WATCH_WINDOW_MS + 1);

    expect(stopped.stop).toBe(true);
    expect(stopped.watch.armedAtMs).toBeNull();
  });

  test("a pending review is pending through PENDING_MAX_MS and stale one millisecond later", () => {
    const armed = armWatch(emptyWatch(), T0);
    const at = T0 + 1000;
    const lines = [started(1, at)];

    expect(tickWatch(armed, lines, SESSION, at + PENDING_MAX_MS).status).toBe(
      "JevGuard reviewing unit 1...",
    );
    expect(tickWatch(armed, lines, SESSION, at + PENDING_MAX_MS + 1).status).toBe(
      "JevGuard · unit 1 · no result yet (run jevguard report)",
    );
  });

  test("the ceiling stops polling even with a pending review", () => {
    const armed = armWatch(emptyWatch(), T0);
    const lines = [started(1, T0 + WATCH_CEILING_MS)];

    expect(tickWatch(armed, lines, SESSION, T0 + WATCH_CEILING_MS).stop).toBe(false);
    expect(tickWatch(armed, lines, SESSION, T0 + WATCH_CEILING_MS + 1).stop).toBe(true);
  });

  test("an unarmed watch stops at once", () => {
    expect(tickWatch(emptyWatch(), [], SESSION, T0).stop).toBe(true);
  });
});
