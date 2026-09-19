import type { RuleHeading, RuleParseErrorCode, RuleParseResult, ParseStep } from "./types";
import { matchRuleHeading } from "./headings";
import { parseRuleMetadata } from "./metadata";
import { parseRuleSections } from "./sections";

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parses one `.jev/rules.md` document into a validated rule, or reports a
 * deterministic `INVALID_RULE` structure. Text only; no file access, scope
 * evaluation, or Jev call.
 */
export function parseRule(text: string): RuleParseResult {
  const lines = splitLines(text);

  const heading = findRuleHeading(lines);

  if (!heading.ok) {
    return invalid(heading.code);
  }

  const body = lines.slice(heading.value.index + 1);

  const metadata = parseRuleMetadata(body);

  if (!metadata.ok) {
    return invalid(metadata.code);
  }

  const sections = parseRuleSections(body);

  if (!sections.ok) {
    return invalid(sections.code);
  }

  return {
    status: "PARSED",
    rule: {
      id: heading.value.id,
      severity: metadata.value.severity,
      scope: metadata.value.scope,
      description: sections.value.rule,
      violation: sections.value.violation,
      allowed: sections.value.allowed,
    },
  };
}

function splitLines(text: string): readonly string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function findRuleHeading(lines: readonly string[]): ParseStep<RuleHeading> {
  const headings = lines.flatMap((line, index) => {
    const id = matchRuleHeading(line);

    return id === null ? [] : [{ index, id }];
  });

  const first = headings[0];

  if (first === undefined) {
    return { ok: false, code: "MISSING_ID" };
  }

  if (headings.length > 1) {
    return { ok: false, code: "MULTIPLE_RULES" };
  }

  if (!RULE_ID.test(first.id)) {
    return { ok: false, code: "INVALID_ID" };
  }

  return { ok: true, value: first };
}

function invalid(code: RuleParseErrorCode): RuleParseResult {
  return { status: "INVALID", reason: "INVALID_RULE", code };
}
