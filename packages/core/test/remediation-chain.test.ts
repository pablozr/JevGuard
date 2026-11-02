import { describe, expect, it } from "vitest";
import type { ChainState, ChainStepInput, RemediationProposalRequest, ReviewResult } from "../src";
import {
  abandonDeliver,
  decideChainStep,
  decideOrphanStep,
  failureSignature,
  isAttemptCount,
  parseChainState,
} from "../src";

const REQUEST = {} as RemediationProposalRequest;

function rule(
  ruleId: string,
  outcome: "PASS" | "WARN" | "FAIL" | "UNAVAILABLE" | "SKIPPED",
  scopedPaths: readonly string[] = ["a.ts"],
  severity: "error" | "warning" = "error",
): ReviewResult {
  const base = { turnId: "t", kind: "RULE", ruleId, severity, scopedPaths } as const;

  if (outcome === "UNAVAILABLE") return { ...base, outcome, reason: "JEV_FAILURE" };
  if (outcome === "SKIPPED") return { ...base, outcome, reason: "NO_SCOPE_MATCH" };

  return { ...base, outcome, violationProbability: 0.9 };
}

function builtIn(checkId: string, outcome: "PASS" | "FAIL"): ReviewResult {
  return {
    turnId: "t",
    kind: "BUILT_IN",
    ruleId: null,
    checkId,
    severity: "error",
    scopedPaths: [],
    outcome,
    violationProbability: 0.9,
  };
}

function input(overrides: Partial<ChainStepInput>): ChainStepInput {
  return {
    mode: "remediate",
    maxAttempts: 2,
    delivery: null,
    chain: null,
    request: REQUEST,
    results: [],
    turnId: "turn-1",
    ...overrides,
  };
}

function stateAfterFirst(results: readonly ReviewResult[]): ChainState {
  const step = decideChainStep(input({ results }));

  if (step.kind !== "DELIVER") throw new Error("expected a delivery");

  return step.state;
}

function correction(
  chain: ChainState,
  results: readonly ReviewResult[],
  overrides: Partial<ChainStepInput> = {},
): ReturnType<typeof decideChainStep> {
  return decideChainStep(
    input({
      delivery: { attempt: chain.attempts, maxAttempts: 2, chainId: chain.chainId },
      chain,
      results,
      turnId: `turn-${chain.attempts + 1}`,
      ...overrides,
    }),
  );
}

const FAIL_A = rule("rule-a", "FAIL");
const FAIL_B = rule("rule-b", "FAIL");

describe("decideChainStep", () => {
  it("never delivers in observe mode", () => {
    expect(decideChainStep(input({ mode: "observe", results: [FAIL_A] })).kind).toBe("NONE");
  });

  it("delivers attempt 1 for a human turn with an error FAIL", () => {
    const step = decideChainStep(input({ results: [FAIL_A, rule("rule-c", "PASS")] }));

    expect(step).toMatchObject({ kind: "DELIVER", chainId: "turn-1", attempt: 1, maxAttempts: 2 });
    expect(step.kind === "DELIVER" && step.state.originIds).toEqual(["rule-a"]);
  });

  it("delivers for a failing built-in check", () => {
    expect(decideChainStep(input({ results: [builtIn("scope-creep", "FAIL")] })).kind).toBe(
      "DELIVER",
    );
  });

  it("never starts from warnings or operational outcomes", () => {
    const results = [
      rule("rule-w", "WARN"),
      rule("rule-x", "FAIL", ["a.ts"], "warning"),
      rule("rule-u", "UNAVAILABLE"),
      rule("rule-s", "SKIPPED"),
    ];

    expect(decideChainStep(input({ results })).kind).toBe("NONE");
  });

  it("does not start when the evidence request is blocked", () => {
    expect(decideChainStep(input({ results: [FAIL_A], request: null })).kind).toBe("NONE");
  });

  it("treats a legacy mark as never delivering again", () => {
    expect(decideChainStep(input({ delivery: "LEGACY", results: [FAIL_A] })).kind).toBe("NONE");
  });

  it("resolves a chain whose findings all pass", () => {
    const chain = stateAfterFirst([FAIL_A, FAIL_B]);
    const step = correction(chain, [rule("rule-a", "PASS"), rule("rule-b", "PASS")], {
      request: null,
    });

    expect(step).toMatchObject({
      kind: "RESOLVED",
      ids: { resolvedIds: ["rule-a", "rule-b"], remainingIds: [] },
    });
  });

  it("stops on the same failure signature", () => {
    const chain = stateAfterFirst([FAIL_A]);

    expect(correction(chain, [FAIL_A])).toMatchObject({ kind: "STOP", code: "REPEATED_FAILURE" });
  });

  it("stops when a finding outside the chain appears, even with attempts left", () => {
    const chain = stateAfterFirst([FAIL_A]);

    expect(correction(chain, [rule("rule-a", "PASS"), FAIL_B])).toMatchObject({
      kind: "STOP",
      code: "REGRESSION_INTRODUCED",
    });
  });

  it("delivers again when the fix reduced the failures, then stops at the limit", () => {
    const first = stateAfterFirst([FAIL_A, FAIL_B]);
    const second = correction(first, [rule("rule-a", "PASS"), FAIL_B]);

    expect(second).toMatchObject({ kind: "DELIVER", attempt: 2, chainId: "turn-1" });

    if (second.kind !== "DELIVER") return;

    const third = correction(second.state, [rule("rule-a", "FAIL"), rule("rule-b", "PASS")]);

    expect(third).toMatchObject({ kind: "STOP", code: "LIMIT" });
  });

  it("honors max_attempts 1 and 3", () => {
    const one = stateAfterFirst([FAIL_A, FAIL_B]);

    expect(correction(one, [rule("rule-a", "PASS"), FAIL_B], { maxAttempts: 1 })).toMatchObject({
      kind: "STOP",
      code: "LIMIT",
    });

    const results = [rule("rule-a", "FAIL"), rule("rule-b", "FAIL"), rule("rule-c", "FAIL")];
    const first = decideChainStep(input({ results, maxAttempts: 3 }));

    if (first.kind !== "DELIVER") throw new Error("expected a delivery");

    const second = correction(
      first.state,
      [rule("rule-a", "PASS"), rule("rule-b", "FAIL"), rule("rule-c", "FAIL")],
      { maxAttempts: 3 },
    );

    if (second.kind !== "DELIVER") throw new Error("expected a second delivery");

    const third = correction(
      second.state,
      [rule("rule-a", "PASS"), rule("rule-b", "PASS"), rule("rule-c", "FAIL")],
      { maxAttempts: 3 },
    );

    expect(third).toMatchObject({ kind: "DELIVER", attempt: 3 });

    if (third.kind !== "DELIVER") return;

    expect(
      correction(third.state, [FAIL_A, rule("rule-b", "PASS"), rule("rule-c", "PASS")], {
        maxAttempts: 3,
      }),
    ).toMatchObject({ kind: "STOP", code: "LIMIT" });
  });

  it("is unverified when a finding became unavailable or skipped", () => {
    const chain = stateAfterFirst([FAIL_A]);

    expect(correction(chain, [rule("rule-a", "UNAVAILABLE")])).toMatchObject({
      code: "UNVERIFIED",
    });
    expect(correction(chain, [rule("rule-a", "SKIPPED")])).toMatchObject({ code: "UNVERIFIED" });
    expect(correction(chain, [])).toMatchObject({ code: "UNVERIFIED" });
  });

  it("is unverified when a finding's scope narrowed", () => {
    const chain = stateAfterFirst([rule("rule-a", "FAIL", ["a.ts", "b.ts"])]);

    expect(correction(chain, [rule("rule-a", "PASS", ["a.ts"])])).toMatchObject({
      code: "UNVERIFIED",
    });
  });

  it("is unverified when a failure has no complete evidence request", () => {
    const chain = stateAfterFirst([FAIL_A, FAIL_B]);

    expect(correction(chain, [rule("rule-a", "PASS"), FAIL_B], { request: null })).toMatchObject({
      code: "UNVERIFIED",
    });
  });

  it("is unverified for an unknown chain, a mismatched attempt or a lost state", () => {
    const chain = stateAfterFirst([FAIL_A]);
    const mark = { attempt: 1, maxAttempts: 2, chainId: "other" };

    expect(decideChainStep(input({ delivery: mark, chain: null, results: [] }))).toMatchObject({
      kind: "STOP",
      code: "UNVERIFIED",
    });
    expect(
      decideChainStep(input({ delivery: { ...mark, chainId: chain.chainId, attempt: 2 }, chain })),
    ).toMatchObject({ code: "UNVERIFIED" });
  });

  it("reports resolved and remaining ids when a chain stops", () => {
    const chain = stateAfterFirst([FAIL_A, FAIL_B]);
    const step = correction(chain, [rule("rule-a", "PASS"), FAIL_B, rule("rule-z", "FAIL")]);

    expect(step).toMatchObject({
      code: "REGRESSION_INTRODUCED",
      ids: { resolvedIds: ["rule-a"], remainingIds: ["rule-b"] },
    });
  });
});

describe("failureSignature", () => {
  it("is stable under permutation of findings and paths", () => {
    const left = [
      { id: "b", scopedPaths: ["y", "x"] },
      { id: "a", scopedPaths: ["z"] },
    ];
    const right = [
      { id: "a", scopedPaths: ["z", "z"] },
      { id: "b", scopedPaths: ["x", "y"] },
    ];

    expect(failureSignature(left)).toBe(failureSignature(right));
    expect(failureSignature(left)).not.toBe(failureSignature([{ id: "a", scopedPaths: ["z"] }]));
  });
});

describe("decideOrphanStep", () => {
  it("ends a saved chain as UNVERIFIED with nothing counted as fixed", () => {
    const chain = stateAfterFirst([rule("rule-a", "FAIL")]);
    const step = decideOrphanStep(chain, 2);

    expect(step).toMatchObject({
      kind: "STOP",
      code: "UNVERIFIED",
      maxAttempts: 2,
      ids: { resolvedIds: [], remainingIds: ["rule-a"] },
    });
  });
});

describe("abandonDeliver", () => {
  it("leaves nothing to end for a first attempt", () => {
    const step = decideChainStep(input({ results: [rule("rule-a", "FAIL")] }));

    if (step.kind !== "DELIVER") throw new Error("expected a delivery");

    expect(abandonDeliver(step, [rule("rule-a", "FAIL")])).toBeNull();
  });

  it("ends a continuation as DELIVERY_FAILED with the state before the attempt", () => {
    const first = [rule("rule-a", "FAIL"), rule("rule-b", "FAIL")];
    const chain = stateAfterFirst(first);
    const after = [rule("rule-a", "PASS"), rule("rule-b", "FAIL")];
    const step = correction(chain, after, {
      delivery: { attempt: 1, maxAttempts: 2, chainId: "turn-1" },
    });

    if (step.kind !== "DELIVER") throw new Error("expected a delivery");

    const stop = abandonDeliver(step, after);

    expect(stop).toMatchObject({
      kind: "STOP",
      code: "DELIVERY_FAILED",
      state: { attempts: 1, turnIds: chain.turnIds, signatures: chain.signatures },
      ids: { resolvedIds: ["rule-a"], remainingIds: ["rule-b"] },
    });
  });
});

describe("isAttemptCount", () => {
  it("accepts integers 1..3 only", () => {
    expect([1, 2, 3].every(isAttemptCount)).toBe(true);
    expect([0, 4, 2.5, "2", null].some(isAttemptCount)).toBe(false);
  });
});

describe("parseChainState", () => {
  const saved = {
    chainId: "c1",
    originIds: ["rule-a"],
    signatures: ["0123456789abcdef"],
    turnIds: ["t1"],
    attempts: 1,
    scopes: { "rule-a": ["a.ts"] },
  };

  it("reads a coherent saved state", () => {
    expect(parseChainState(saved)).toEqual(saved);
  });

  it.each([
    ["extra attempts without a signature", { ...saved, attempts: 2 }],
    ["a bad signature", { ...saved, signatures: ["nope"] }],
    ["an origin without a scope", { ...saved, scopes: {} }],
    ["a bad chain id", { ...saved, chainId: "a b" }],
    ["no origins", { ...saved, originIds: [], scopes: {} }],
  ])("rejects %s", (_name, value) => {
    expect(parseChainState(value)).toBeNull();
  });

  it("rejects what is not a record", () => {
    expect(parseChainState(null)).toBeNull();
    expect(parseChainState([saved])).toBeNull();
  });
});
