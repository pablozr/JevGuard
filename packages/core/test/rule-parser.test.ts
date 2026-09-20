import { describe, expect, test } from "vitest";
import { parseRule, parseRules } from "../src/index";
import type { ParsedRule, RuleParseErrorCode, RuleParseResult } from "../src/index";

const validRule = [
  "## ARCH-001",
  "",
  "severity: error",
  "scope: backend/**",
  "",
  "### Rule",
  "",
  "HTTP controllers must not contain business logic.",
  "",
  "### Violation",
  "",
  "A controller performs domain decisions, calculations, or state mutations directly.",
  "",
  "### Allowed",
  "",
  "Validation, HTTP mapping and delegation to services.",
  "",
].join("\n");

function expectParsed(text: string): ParsedRule {
  const result = parseRule(text);

  if (result.status !== "PARSED") {
    throw new Error(`Expected a parsed rule but received ${result.code}`);
  }

  return result.rule;
}

function expectInvalid(text: string, code: RuleParseErrorCode): void {
  const result: RuleParseResult = parseRule(text);

  expect(result.status).toBe("INVALID");

  if (result.status === "INVALID") {
    expect(result.reason).toBe("INVALID_RULE");
    expect(result.code).toBe(code);
  }
}

function ruleBlock(id: string, description: string, violation: string): string {
  return [
    `## ${id}`,
    "",
    "severity: error",
    "",
    "### Rule",
    "",
    description,
    "",
    "### Violation",
    "",
    violation,
  ].join("\n");
}

describe("parseRule", () => {
  test("parses a complete rule into a typed value", () => {
    expect(expectParsed(validRule)).toEqual({
      id: "ARCH-001",
      severity: "error",
      scope: "backend/**",
      description: "HTTP controllers must not contain business logic.",
      violation:
        "A controller performs domain decisions, calculations, or state mutations directly.",
      allowed: "Validation, HTTP mapping and delegation to services.",
    });
  });

  test("accepts a rule without scope and without Allowed", () => {
    const text = [
      "## SIMPLE-1",
      "",
      "severity: warning",
      "",
      "### Rule",
      "",
      "Prefer small modules.",
      "",
      "### Violation",
      "",
      "A module mixes unrelated concerns.",
    ].join("\n");

    const rule = expectParsed(text);

    expect(rule.severity).toBe("warning");
    expect(rule.scope).toBeNull();
    expect(rule.allowed).toBeNull();
  });

  test("keeps Allowed inside the rule when scope is omitted", () => {
    const text = [
      "## SCOPELESS-1",
      "severity: error",
      "### Rule",
      "R",
      "### Violation",
      "V",
      "### Allowed",
      "A",
    ].join("\n");

    const rule = expectParsed(text);

    expect(rule.scope).toBeNull();
    expect(rule.allowed).toBe("A");
  });

  test("preserves multi-line section text for later Jev criteria", () => {
    const text = [
      "## MULTI-1",
      "severity: error",
      "### Rule",
      "First line.",
      "Second line.",
      "### Violation",
      "A violation.",
    ].join("\n");

    expect(expectParsed(text).description).toBe("First line.\nSecond line.");
  });

  test("parses CRLF documents", () => {
    expect(expectParsed(validRule.replace(/\n/g, "\r\n")).id).toBe("ARCH-001");
  });

  test("ignores content before the rule heading", () => {
    const text = ["# Repository rules", "", validRule].join("\n");

    expect(expectParsed(text).id).toBe("ARCH-001");
  });

  test("rejects a document without a rule heading", () => {
    const text = ["severity: error", "### Rule", "A rule.", "### Violation", "A violation."].join(
      "\n",
    );

    expectInvalid(text, "MISSING_ID");
  });

  test("rejects a heading whose ID contains invalid characters", () => {
    const text = validRule.replace("## ARCH-001", "## ARCH 001");

    expectInvalid(text, "INVALID_ID");
  });

  test("rejects a document that contains more than one rule", () => {
    const text = [
      "## R-1",
      "severity: error",
      "### Rule",
      "A.",
      "### Violation",
      "B.",
      "## R-2",
      "severity: error",
      "### Rule",
      "C.",
      "### Violation",
      "D.",
    ].join("\n");

    expectInvalid(text, "MULTIPLE_RULES");
  });

  test("rejects a missing severity", () => {
    const text = ["## R-1", "### Rule", "A rule.", "### Violation", "A violation."].join("\n");

    expectInvalid(text, "MISSING_SEVERITY");
  });

  test("rejects an unknown severity", () => {
    const text = validRule.replace("severity: error", "severity: fatal");

    expectInvalid(text, "INVALID_SEVERITY");
  });

  test("rejects malformed metadata lines", () => {
    const text = validRule.replace("severity: error", "severity error");

    expectInvalid(text, "MALFORMED_METADATA");
  });

  test("rejects unknown metadata keys", () => {
    const text = validRule.replace("severity: error", "severity: error\nowner: team");

    expectInvalid(text, "MALFORMED_METADATA");
  });

  test("rejects duplicate metadata keys", () => {
    const text = validRule.replace("severity: error", "severity: error\nseverity: warning");

    expectInvalid(text, "DUPLICATE_METADATA");
  });

  test("rejects an empty scope value instead of guessing", () => {
    const text = validRule.replace("scope: backend/**", "scope:");

    expectInvalid(text, "MALFORMED_METADATA");
  });

  test("rejects a missing Rule section", () => {
    const text = ["## R-1", "severity: error", "### Violation", "A violation."].join("\n");

    expectInvalid(text, "MISSING_RULE");
  });

  test("rejects a missing Violation section", () => {
    const text = ["## R-1", "severity: error", "### Rule", "A rule."].join("\n");

    expectInvalid(text, "MISSING_VIOLATION");
  });

  test("rejects a duplicated section", () => {
    const text = [
      "## R-1",
      "severity: error",
      "### Rule",
      "A.",
      "### Rule",
      "B.",
      "### Violation",
      "C.",
    ].join("\n");

    expectInvalid(text, "DUPLICATE_SECTION");
  });

  test("rejects an unknown section", () => {
    const text = validRule.replace("### Allowed", "### Notes");

    expectInvalid(text, "UNKNOWN_SECTION");
  });

  test("rejects an empty required section", () => {
    const text = ["## R-1", "severity: error", "### Rule", "### Violation", "A violation."].join(
      "\n",
    );

    expectInvalid(text, "EMPTY_SECTION");
  });

  test("rejects an empty Allowed section", () => {
    const text = [
      "## R-1",
      "severity: error",
      "### Rule",
      "A rule.",
      "### Violation",
      "A violation.",
      "### Allowed",
    ].join("\n");

    expectInvalid(text, "EMPTY_ALLOWED");
  });

  test("rejects an Allowed section identical to Violation", () => {
    const text = [
      "## R-1",
      "severity: error",
      "### Rule",
      "A rule.",
      "### Violation",
      "A violation.",
      "### Allowed",
      "A violation.",
    ].join("\n");

    expectInvalid(text, "ALLOWED_EQUALS_VIOLATION");
  });

  test("keeps the V0.1 failure shape without a ruleId", () => {
    const text = ["## R-1", "### Rule", "A rule.", "### Violation", "A violation."].join("\n");

    const result: RuleParseResult = parseRule(text);

    expect(result).toEqual({ status: "INVALID", reason: "INVALID_RULE", code: "MISSING_SEVERITY" });
    expect("ruleId" in result).toBe(false);
  });
});

describe("parseRules", () => {
  test("parses every rule block in source order", () => {
    const text = [
      ruleBlock("A-1", "Rule A.", "Violation A."),
      ruleBlock("B-2", "Rule B.", "Violation B."),
    ].join("\n");

    const results = parseRules(text);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ status: "PARSED", rule: { id: "A-1" } });
    expect(results[1]).toMatchObject({ status: "PARSED", rule: { id: "B-2" } });
  });

  test("continues past an invalid sibling block", () => {
    const text = [
      "## A-1",
      "### Rule",
      "A rule.",
      "### Violation",
      "A violation.",
      ruleBlock("B-2", "Rule B.", "Violation B."),
    ].join("\n");

    const results = parseRules(text);

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      status: "INVALID",
      code: "MISSING_SEVERITY",
      ruleId: "A-1",
    });
    expect(results[1]).toMatchObject({ status: "PARSED", rule: { id: "B-2" } });
  });

  test("invalidates every occurrence of a duplicated rule ID", () => {
    const text = [
      ruleBlock("A-1", "Rule A.", "Violation A."),
      ruleBlock("B-2", "Rule B.", "Violation B."),
      ruleBlock("A-1", "Rule A again.", "Violation A again."),
    ].join("\n");

    const results = parseRules(text);

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ status: "INVALID", code: "DUPLICATE_ID", ruleId: "A-1" });
    expect(results[1]).toMatchObject({ status: "PARSED", rule: { id: "B-2" } });
    expect(results[2]).toMatchObject({ status: "INVALID", code: "DUPLICATE_ID", ruleId: "A-1" });
  });

  test("ranks duplicate detection above other block failures", () => {
    const duplicateWithoutSeverity = [
      "## A-1",
      "### Rule",
      "A rule.",
      "### Violation",
      "A violation.",
    ].join("\n");

    const results = parseRules(
      [duplicateWithoutSeverity, ruleBlock("A-1", "Rule A.", "Violation A.")].join("\n"),
    );

    expect(results[0]).toMatchObject({ status: "INVALID", code: "DUPLICATE_ID", ruleId: "A-1" });
    expect(results[1]).toMatchObject({ status: "INVALID", code: "DUPLICATE_ID", ruleId: "A-1" });
  });

  test("returns one missing-ID failure when no rule heading exists", () => {
    const text = [
      "# Repository rules",
      "### Rule",
      "A rule.",
      "### Violation",
      "A violation.",
    ].join("\n");

    const results = parseRules(text);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      status: "INVALID",
      reason: "INVALID_RULE",
      code: "MISSING_ID",
      ruleId: null,
    });
  });

  test("ignores preamble and reports an invalid heading ID with a null rule ID", () => {
    const text = ["# Repository rules", "## ARCH 001", "severity: error"].join("\n");

    const results = parseRules(text);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "INVALID", code: "INVALID_ID", ruleId: null });
  });

  test("does not apply MULTIPLE_RULES to a multi-rule document", () => {
    const text = [
      ruleBlock("A-1", "Rule A.", "Violation A."),
      ruleBlock("B-2", "Rule B.", "Violation B."),
    ].join("\n");

    const statuses = parseRules(text).map((result) => result.status);

    expect(statuses).toEqual(["PARSED", "PARSED"]);
  });
});
