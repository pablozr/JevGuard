import { describe, expect, test } from "vitest";
import {
  DEFAULT_EVIDENCE_POLICY,
  MAX_EXTRA_RULE_CALLS_PER_TURN,
  MAX_SLICES_PER_RULE,
  planRuleEvidence,
  planTurnRuleSlices,
} from "../src/index";
import type {
  EvidencePolicy,
  EvidenceSlice,
  ParsedRule,
  RuleEvidencePlan,
  Turn,
  TurnFile,
} from "../src/index";

function file(path: string, patch: string): TurnFile {
  return { path, patch };
}

function makeRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: "R-1",
    severity: "error",
    scope: null,
    evidence: "code",
    description: "A rule.",
    violation: "A violation.",
    allowed: null,
    ...overrides,
  };
}

function policy(maxDiffLength: number): EvidencePolicy {
  return { ...DEFAULT_EVIDENCE_POLICY, maxDiffLength };
}

function planned(result: RuleEvidencePlan): readonly EvidenceSlice[] {
  if (result.status !== "PLANNED") {
    throw new Error(`expected PLANNED, got ${result.status}`);
  }

  return result.slices;
}

function planOf(count: number): RuleEvidencePlan {
  return {
    status: "PLANNED",
    slices: Array.from({ length: count }, (_unused, index) => ({
      index,
      kind: "FILE" as const,
      path: `f${index}.ts`,
      hunkOrdinal: null,
      files: [`f${index}.ts`],
      diff: "x",
    })),
  };
}

const PREAMBLE = "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n";
const HUNK_ONE = "@@ -1,3 +1,4 @@\n a\n+b\n c\n d\n";
const HUNK_TWO = "@@ -9,1 +10,1 @@\n-e\n+f\n";

describe("planRuleEvidence whole slices", () => {
  test("keeps one WHOLE slice with every applicable file at or below the limit", () => {
    const turn: Turn = {
      id: "turn-1",
      task: "task",
      files: [file("src/a.ts", "patch-a"), file("src/b.ts", "patch-b")],
    };

    expect(planned(planRuleEvidence(turn, makeRule(), policy(100)))).toEqual([
      {
        index: 0,
        kind: "WHOLE",
        path: null,
        hunkOrdinal: null,
        files: ["src/a.ts", "src/b.ts"],
        diff: "patch-a\npatch-b",
      },
    ]);
  });

  test("names the single path of a one-file WHOLE slice", () => {
    const turn: Turn = { id: "turn-1", task: "task", files: [file("src/a.ts", "patch-a")] };

    expect(planned(planRuleEvidence(turn, makeRule(), policy(100)))).toEqual([
      {
        index: 0,
        kind: "WHOLE",
        path: "src/a.ts",
        hunkOrdinal: null,
        files: ["src/a.ts"],
        diff: "patch-a",
      },
    ]);
  });

  test("accepts a whole diff exactly at the limit", () => {
    const turn: Turn = { id: "turn-1", task: "task", files: [file("src/a.ts", "0123456789")] };

    expect(planned(planRuleEvidence(turn, makeRule(), policy(10)))).toHaveLength(1);
  });
});

describe("planRuleEvidence file and hunk slices", () => {
  test("splits an oversized multi-file rule into ordered FILE slices", () => {
    const turn: Turn = {
      id: "turn-1",
      task: "task",
      files: [file("src/a.ts", "patch-a-111"), file("src/b.ts", "patch-b-222")],
    };

    const slices = planned(planRuleEvidence(turn, makeRule(), policy(12)));

    expect(slices.map((slice) => slice.kind)).toEqual(["FILE", "FILE"]);
    expect(slices.map((slice) => slice.index)).toEqual([0, 1]);
    expect(slices.map((slice) => slice.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(slices.map((slice) => slice.files)).toEqual([["src/a.ts"], ["src/b.ts"]]);
    expect(slices.map((slice) => slice.diff)).toEqual(["patch-a-111", "patch-b-222"]);
  });

  test("splits an oversized file into ordered HUNK slices with the preamble repeated", () => {
    const patch = PREAMBLE + HUNK_ONE + HUNK_TWO;
    const limit = Math.max((PREAMBLE + HUNK_ONE).length, (PREAMBLE + HUNK_TWO).length);

    expect(patch.length).toBeGreaterThan(limit);

    const turn: Turn = { id: "turn-1", task: "task", files: [file("x.ts", patch)] };
    const slices = planned(planRuleEvidence(turn, makeRule(), policy(limit)));

    expect(slices).toEqual([
      {
        index: 0,
        kind: "HUNK",
        path: "x.ts",
        hunkOrdinal: 0,
        files: ["x.ts"],
        diff: PREAMBLE + HUNK_ONE,
      },
      {
        index: 1,
        kind: "HUNK",
        path: "x.ts",
        hunkOrdinal: 1,
        files: ["x.ts"],
        diff: PREAMBLE + HUNK_TWO,
      },
    ]);
  });

  test("accepts a hunk slice exactly at the limit", () => {
    const patch = PREAMBLE + HUNK_ONE + HUNK_TWO;
    const limit = (PREAMBLE + HUNK_ONE).length;
    const turn: Turn = { id: "turn-1", task: "task", files: [file("x.ts", patch)] };

    const slices = planned(planRuleEvidence(turn, makeRule(), policy(limit)));

    expect(slices[0]?.diff.length).toBe(limit);
    expect(slices).toHaveLength(2);
  });

  test("keeps each request's task and one Noul per slice while changing only the change", () => {
    const turn: Turn = {
      id: "turn-1",
      task: "task",
      files: [file("src/a.ts", "patch-a-111"), file("src/b.ts", "patch-b-222")],
    };

    const slices = planned(planRuleEvidence(turn, makeRule(), policy(12)));

    expect(slices.every((slice) => slice.diff.length > 0)).toBe(true);
    expect(slices.map((slice) => slice.files.length)).toEqual([1, 1]);
  });
});

describe("planRuleEvidence indivisible evidence", () => {
  test("makes an unparseable oversized file OVERSIZED_DIFF for the whole rule", () => {
    const turn: Turn = {
      id: "turn-1",
      task: "task",
      files: [file("src/a.ts", "x".repeat(40))],
    };

    expect(planRuleEvidence(turn, makeRule(), policy(10))).toEqual({
      status: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
  });

  test("makes a single oversized hunk OVERSIZED_DIFF for the whole rule", () => {
    const patch = `${PREAMBLE}@@ -1,1 +1,1 @@\n${"x".repeat(60)}\n`;
    const turn: Turn = { id: "turn-1", task: "task", files: [file("x.ts", patch)] };

    expect(planRuleEvidence(turn, makeRule(), policy(20))).toEqual({
      status: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
  });

  test("rejects the whole rule when a later file is indivisible", () => {
    const turn: Turn = {
      id: "turn-1",
      task: "task",
      files: [file("src/a.ts", "patch-a-111"), file("src/big.ts", "y".repeat(40))],
    };

    expect(planRuleEvidence(turn, makeRule(), policy(12))).toEqual({
      status: "UNAVAILABLE",
      reason: "OVERSIZED_DIFF",
    });
  });
});

describe("planRuleEvidence safety and terminal states", () => {
  test("makes a blocked applicable path BLOCKED_EVIDENCE for the whole rule with no slice", () => {
    const turn: Turn = {
      id: "turn-1",
      task: "task",
      files: [file("src/a.ts", "patch-a-111"), file("src/.env", "SECRET=1")],
    };
    const rule = makeRule({ scope: { include: ["**"], exclude: [] } });

    expect(planRuleEvidence(turn, rule, policy(5))).toEqual({
      status: "UNAVAILABLE",
      reason: "BLOCKED_EVIDENCE",
    });
  });

  test("skips without a plan when the turn has no attributed patch", () => {
    const turn: Turn = { id: "turn-1", task: "task", files: [file("src/a.ts", "   ")] };

    expect(planRuleEvidence(turn, makeRule())).toEqual({
      status: "SKIPPED",
      reason: "NO_ATTRIBUTED_PATCH",
    });
  });

  test("skips without a plan when the scope matches no changed file", () => {
    const turn: Turn = { id: "turn-1", task: "task", files: [file("docs/a.md", "patch")] };
    const rule = makeRule({ scope: { include: ["src/**"], exclude: [] } });

    expect(planRuleEvidence(turn, rule)).toEqual({
      status: "SKIPPED",
      reason: "NO_SCOPE_MATCH",
    });
  });
});

describe("planTurnRuleSlices", () => {
  test("admits up to 16 slices and rejects a larger rule", () => {
    expect(planTurnRuleSlices([planOf(MAX_SLICES_PER_RULE)])[0]?.status).toBe("PLANNED");

    const [over] = planTurnRuleSlices([planOf(MAX_SLICES_PER_RULE + 1)]);

    expect(over?.status).toBe("SLICE_LIMIT_EXCEEDED");
    expect(over?.status === "SLICE_LIMIT_EXCEEDED" ? over.slices.length : 0).toBe(
      MAX_SLICES_PER_RULE + 1,
    );
  });

  test("reserves extra slice calls in source order and still serves later rules", () => {
    const budgeted = planTurnRuleSlices([
      planOf(20),
      planOf(16),
      planOf(16),
      planOf(4),
      planOf(3),
      planOf(2),
    ]);

    expect(budgeted.map((plan) => plan.status)).toEqual([
      "SLICE_LIMIT_EXCEEDED",
      "PLANNED",
      "PLANNED",
      "SLICE_LIMIT_EXCEEDED",
      "PLANNED",
      "SLICE_LIMIT_EXCEEDED",
    ]);
  });

  test("does not spend budget on a rejected rule", () => {
    const budgeted = planTurnRuleSlices([planOf(20), planOf(16)]);

    expect(budgeted.map((plan) => plan.status)).toEqual(["SLICE_LIMIT_EXCEEDED", "PLANNED"]);
  });

  test("always admits a one-slice whole rule", () => {
    const budgeted = planTurnRuleSlices([planOf(16), planOf(16), planOf(1)]);

    expect(budgeted.map((plan) => plan.status)).toEqual(["PLANNED", "PLANNED", "PLANNED"]);
    expect(MAX_EXTRA_RULE_CALLS_PER_TURN).toBe(32);
  });
});
