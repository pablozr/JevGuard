import type { GateConfig, ParsedRule, Turn } from "../domain/types";
import type { EvidencePolicy } from "../evidence/types";
import type { JevEvaluationPort } from "../ports/types";

export interface EvaluateRuleInput {
  readonly turn: Turn;
  readonly rule: ParsedRule;
  readonly gateConfig: GateConfig;
  readonly evidencePolicy: EvidencePolicy;
}

export interface EvaluateRuleDependencies {
  readonly jev: JevEvaluationPort;
}
