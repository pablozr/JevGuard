import type { ParsedRule, ReviewResult, TurnFile } from "../domain/types";
import type { RuleParseResults } from "../rules/types";
import { locationsOf } from "./finding-locations";
import type {
  RemediationBuiltInFinding,
  RemediationRuleFinding,
  RemediationRuleSnapshot,
} from "./types";

/** Every `FAIL` finding of a reviewed turn: local `error` rules, then built-in checks. */
export interface FailFindings {
  readonly ruleFindings: readonly RemediationRuleFinding[];
  readonly builtInFindings: readonly RemediationBuiltInFinding[];
}

/** Collects the `FAIL` findings of a turn's review results, with where each one failed. */
export function collectFailFindings(input: {
  readonly files: readonly TurnFile[];
  readonly rules: RuleParseResults;
  readonly results: readonly ReviewResult[];
}): FailFindings {
  return {
    ruleFindings: collectRuleFindings(input.results, indexParsedRules(input.rules), input.files),
    builtInFindings: collectBuiltInFindings(input.results, input.files),
  };
}

function collectRuleFindings(
  results: readonly ReviewResult[],
  rulesById: ReadonlyMap<string, ParsedRule>,
  files: readonly TurnFile[],
): readonly RemediationRuleFinding[] {
  const findings: RemediationRuleFinding[] = [];

  for (const result of results) {
    if (!isFailingRule(result)) {
      continue;
    }

    const rule = rulesById.get(result.ruleId);

    if (rule === undefined) {
      continue;
    }

    findings.push({
      ruleId: rule.id,
      severity: "error",
      rule: snapshotRule(rule),
      probability: result.violationProbability,
      scopedPaths: [...result.scopedPaths],
      locations: locationsOf(result, files),
    });
  }

  return findings;
}

function collectBuiltInFindings(
  results: readonly ReviewResult[],
  files: readonly TurnFile[],
): readonly RemediationBuiltInFinding[] {
  const findings: RemediationBuiltInFinding[] = [];

  for (const result of results) {
    if (result.kind !== "BUILT_IN" || result.outcome !== "FAIL") {
      continue;
    }

    findings.push({
      checkId: result.checkId,
      severity: result.severity,
      probability: result.violationProbability,
      scopedPaths: [...result.scopedPaths],
      locations: locationsOf(result, files),
    });
  }

  return findings;
}

function isFailingRule(result: ReviewResult): result is Extract<ReviewResult, { kind: "RULE" }> & {
  readonly outcome: "FAIL";
  readonly severity: "error";
  readonly ruleId: string;
} {
  return (
    result.kind === "RULE" &&
    result.outcome === "FAIL" &&
    result.severity === "error" &&
    result.ruleId !== null
  );
}

function indexParsedRules(rules: RuleParseResults): ReadonlyMap<string, ParsedRule> {
  const byId = new Map<string, ParsedRule>();

  for (const candidate of rules) {
    if (candidate.status === "PARSED") {
      byId.set(candidate.rule.id, candidate.rule);
    }
  }

  return byId;
}

function snapshotRule(rule: ParsedRule): RemediationRuleSnapshot {
  return {
    id: rule.id,
    description: rule.description,
    violation: rule.violation,
    allowed: rule.allowed ?? "",
  };
}
