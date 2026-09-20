import type { GateConfig, ParsedRule, Turn } from "../domain/types";
import type { EvidencePolicy } from "../evidence/types";
import type { GateConfigResult } from "../gate/types";
import type { JevEvaluationPort } from "../ports/types";
import type { RuleParseResults } from "../rules/types";

export interface EvaluateRuleInput {
  readonly turn: Turn;
  readonly rule: ParsedRule;
  readonly gateConfig: GateConfig;
  readonly evidencePolicy: EvidencePolicy;
}

export interface EvaluateRuleDependencies {
  readonly jev: JevEvaluationPort;
}

/**
 * Multi-rule evaluation input. `rules` is a parser result array so invalid blocks
 * remain addressable, and `gateConfig` is the resolved configuration result so a
 * single invalid configuration is represented per rule.
 */
export interface EvaluateRulesInput {
  readonly turn: Turn;
  readonly rules: RuleParseResults;
  readonly gateConfig: GateConfigResult;
  readonly evidencePolicy: EvidencePolicy;
}
