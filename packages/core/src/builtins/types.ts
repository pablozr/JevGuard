import type { Turn } from "../domain/types";
import type { EvidencePolicy } from "../evidence/types";
import type { JevEvaluationPort } from "../ports/types";

/** Input for one scope-free built-in check: the completed turn and the evidence policy. */
export interface EvaluateBuiltInInput {
  readonly turn: Turn;
  readonly evidencePolicy: EvidencePolicy;
}

export interface EvaluateBuiltInDependencies {
  readonly jev: JevEvaluationPort;
}

export type EvaluateScopeCreepInput = EvaluateBuiltInInput;

export type EvaluateScopeCreepDependencies = EvaluateBuiltInDependencies;

export type EvaluateComplexityInput = EvaluateBuiltInInput;

export type EvaluateComplexityDependencies = EvaluateBuiltInDependencies;
