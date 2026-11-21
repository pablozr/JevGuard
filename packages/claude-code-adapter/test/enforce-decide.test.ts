import type { ReviewResult } from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  decideEnforce,
  ENFORCE_REASON_MAX_LENGTH,
  enforceReason,
  toStopOutput,
  type EnforceInput,
} from "../src/enforce";

const SETTINGS = { rules: ["SECRETS-001", "DESTRUCTIVE-001"], budgetMs: 8000 };

const TURN = { turnId: "unit-1", scopedPaths: [] };

function rule(
  ruleId: string,
  outcome: "PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE",
  severity: "error" | "warning" = "error",
): ReviewResult {
  const identity = { kind: "RULE" as const, ...TURN, ruleId, severity };

  switch (outcome) {
    case "SKIPPED":
      return { ...identity, outcome, reason: "NO_SCOPE_MATCH" };
    case "UNAVAILABLE":
      return { ...identity, outcome, reason: "JEV_FAILURE" };
    default:
      return { ...identity, outcome, violationProbability: 0.91 };
  }
}

function builtIn(outcome: "PASS" | "FAIL"): ReviewResult {
  const identity = {
    kind: "BUILT_IN" as const,
    ...TURN,
    ruleId: null,
    checkId: "SCOPE-CREEP",
    severity: "warning" as const,
  };

  return outcome === "PASS"
    ? { ...identity, outcome, violationProbability: 0.1 }
    : { ...identity, outcome, violationProbability: 0.91 };
}

function input(overrides: Partial<EnforceInput> = {}): EnforceInput {
  return {
    settings: SETTINGS,
    review: { results: [rule("SECRETS-001", "FAIL")] },
    session: "INTERACTIVE",
    backgroundTasks: "EMPTY",
    stopHookActive: false,
    unitAlreadyBlocked: false,
    acknowledged: false,
    ...overrides,
  };
}

describe("decideEnforce", () => {
  test("blocks a turn whose allowlisted error rule failed", () => {
    const decision = decideEnforce(input());

    expect(decision).toEqual({
      block: true,
      ruleIds: ["SECRETS-001"],
      reason:
        "JevGuard blocked this turn: SECRETS-001 failed. Fix the change, or explain why the rule does not apply, then finish the turn again.",
    });
    expect(toStopOutput(decision)).toEqual({
      decision: "block",
      reason:
        "JevGuard blocked this turn: SECRETS-001 failed. Fix the change, or explain why the rule does not apply, then finish the turn again.",
    });
  });

  test("names the failing rules in configured order", () => {
    const decision = decideEnforce(
      input({
        review: {
          results: [rule("DESTRUCTIVE-001", "FAIL"), builtIn("FAIL"), rule("SECRETS-001", "FAIL")],
        },
      }),
    );

    expect(decision).toMatchObject({ block: true, ruleIds: ["SECRETS-001", "DESTRUCTIVE-001"] });
  });

  test.each([
    [
      "a non-interactive session",
      { session: "NON_INTERACTIVE" as const },
      "ENFORCE_NON_INTERACTIVE",
    ],
    ["a session it cannot classify", { session: "UNKNOWN" as const }, "ENFORCE_NON_INTERACTIVE"],
    [
      "an active background task",
      { backgroundTasks: "ACTIVE" as const },
      "ENFORCE_BACKGROUND_TASK",
    ],
    [
      "background tasks it cannot read",
      { backgroundTasks: "UNKNOWN" as const },
      "ENFORCE_BACKGROUND_TASK",
    ],
    ["a continued stop", { stopHookActive: true }, "ENFORCE_CAP_REACHED"],
    ["a unit already blocked once", { unitAlreadyBlocked: true }, "ENFORCE_CAP_REACHED"],
    ["an acknowledged unit", { acknowledged: true }, "ENFORCE_ACKED"],
  ])("fails open on %s", (_name, overrides, code) => {
    const decision = decideEnforce(input(overrides));

    expect(decision).toEqual({ block: false, code });
    expect(toStopOutput(decision)).toBeNull();
  });

  test("never blocks without an eligible rule", () => {
    expect(decideEnforce(input({ settings: { rules: [], budgetMs: 8000 } }))).toEqual({
      block: false,
      code: "ENFORCE_NO_ELIGIBLE_RULES",
    });
  });

  test.each([
    ["a PASS", rule("SECRETS-001", "PASS")],
    ["a rule outside the allowlist", rule("API-001", "FAIL")],
    ["a warning rule in FAIL", rule("SECRETS-001", "FAIL", "warning")],
    ["an UNAVAILABLE result", rule("SECRETS-001", "UNAVAILABLE")],
    ["a SKIPPED result", rule("SECRETS-001", "SKIPPED")],
    ["a built-in in FAIL", builtIn("FAIL")],
  ])("does not block on %s", (_name, result) => {
    expect(decideEnforce(input({ review: { results: [result] } }))).toEqual({
      block: false,
      code: "ENFORCE_NO_FAIL",
    });
  });

  test("keeps a block when another rule was unavailable", () => {
    const decision = decideEnforce(
      input({ review: { results: [rule("SECRETS-001", "FAIL"), rule("API-001", "UNAVAILABLE")] } }),
    );

    expect(decision).toMatchObject({ block: true, ruleIds: ["SECRETS-001"] });
  });
});

describe("enforceReason", () => {
  test("carries rule IDs only", () => {
    const reason = enforceReason(["SECRETS-001", "DESTRUCTIVE-001"]);

    expect(reason).toContain("SECRETS-001, DESTRUCTIVE-001");
    expect(reason.length).toBeLessThanOrEqual(ENFORCE_REASON_MAX_LENGTH);
  });

  test("stays under the cap and counts the rules it cannot name", () => {
    const many = Array.from({ length: 200 }, (_value, index) => `RULE-${index}`);

    const reason = enforceReason(many);

    expect(reason.length).toBeLessThanOrEqual(ENFORCE_REASON_MAX_LENGTH);
    expect(reason).toMatch(/ and \d+ more failed\./);
    expect(reason).not.toContain("RULE-199,");
  });

  test("never cuts a rule ID in half", () => {
    const many = Array.from({ length: 200 }, (_value, index) => `RULE-${index}`);
    const reason = enforceReason(many);
    const named = reason.slice(0, reason.indexOf(" and "));

    for (const fragment of named.split("blocked this turn: ")[1]?.split(", ") ?? []) {
      expect(many).toContain(fragment);
    }
  });
});
