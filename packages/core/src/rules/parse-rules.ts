import type { RuleParseResults } from "./types";
import { collectRuleBlocks, isValidRuleId, parseRuleBlock, ruleCandidateFailure } from "./blocks";

/**
 * Parses every rule block in a `.jev/rules.md` document in source order. Each
 * `##` block is validated independently, so one invalid block does not suppress
 * its valid siblings. Every occurrence of a duplicated valid ID is invalid.
 */
export function parseRules(text: string): RuleParseResults {
  const blocks = collectRuleBlocks(text);

  if (blocks.length === 0) {
    return [ruleCandidateFailure("MISSING_ID", null)];
  }

  const duplicates = findDuplicateIds(blocks.map((block) => block.id));

  return blocks.map((block) => parseRuleBlock(block, duplicates.has(block.id)));
}

function findDuplicateIds(ids: readonly string[]): ReadonlySet<string> {
  const counts = new Map<string, number>();

  for (const id of ids) {
    if (!isValidRuleId(id)) {
      continue;
    }

    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const duplicates = new Set<string>();

  for (const [id, count] of counts) {
    if (count > 1) {
      duplicates.add(id);
    }
  }

  return duplicates;
}
