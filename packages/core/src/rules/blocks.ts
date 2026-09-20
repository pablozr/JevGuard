import type { ParsedRule } from "../domain/types";
import { matchRuleHeading } from "./headings";
import { parseRuleMetadata } from "./metadata";
import { parseRuleSections } from "./sections";
import type {
  RuleBlock,
  RuleCandidateFailure,
  RuleCandidateResult,
  RuleMetadata,
  RuleParseErrorCode,
  RuleParseFailure,
  RuleSections,
} from "./types";

const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidRuleId(id: string): boolean {
  return RULE_ID.test(id);
}

/**
 * Splits a document into rule blocks in source order. Every `##` heading opens a
 * block that runs to the next `##` heading; content before the first heading is
 * ignored.
 */
export function collectRuleBlocks(text: string): readonly RuleBlock[] {
  const blocks: { id: string; body: string[] }[] = [];
  let current: { id: string; body: string[] } | null = null;

  for (const line of splitLines(text)) {
    const id = matchRuleHeading(line);

    if (id !== null) {
      current = { id, body: [] };
      blocks.push(current);
      continue;
    }

    if (current !== null) {
      current.body.push(line);
    }
  }

  return blocks;
}

/**
 * Validates one rule block. A valid heading ID is retained on every structural
 * failure; an invalid heading ID and a duplicated ID deny the block a rule ID.
 */
export function parseRuleBlock(block: RuleBlock, duplicate: boolean): RuleCandidateResult {
  if (!isValidRuleId(block.id)) {
    return ruleCandidateFailure("INVALID_ID", null);
  }

  if (duplicate) {
    return ruleCandidateFailure("DUPLICATE_ID", block.id);
  }

  const metadata = parseRuleMetadata(block.body);

  if (!metadata.ok) {
    return ruleCandidateFailure(metadata.code, block.id);
  }

  const sections = parseRuleSections(block.body);

  if (!sections.ok) {
    return ruleCandidateFailure(sections.code, block.id);
  }

  return {
    status: "PARSED",
    rule: buildParsedRule(block.id, metadata.value, sections.value),
  };
}

export function ruleParseFailure(code: RuleParseErrorCode): RuleParseFailure {
  return { status: "INVALID", reason: "INVALID_RULE", code };
}

export function ruleCandidateFailure(
  code: RuleParseErrorCode,
  ruleId: string | null,
): RuleCandidateFailure {
  return { status: "INVALID", reason: "INVALID_RULE", code, ruleId };
}

function splitLines(text: string): readonly string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

function buildParsedRule(id: string, metadata: RuleMetadata, sections: RuleSections): ParsedRule {
  return {
    id,
    severity: metadata.severity,
    scope: metadata.scope,
    description: sections.rule,
    violation: sections.violation,
    allowed: sections.allowed,
  };
}
