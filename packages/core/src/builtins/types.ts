import type { BuiltInReviewResult, Turn } from "../domain/types";
import type { EvidencePolicy } from "../evidence/types";
import type { JevEvaluationPort } from "../ports/types";

/** Input for the single scope-free built-in batch: the turn and the evidence policy. */
export interface EvaluateBuiltInsInput {
  readonly turn: Turn;
  readonly evidencePolicy: EvidencePolicy;
}

export interface EvaluateBuiltInsDependencies {
  readonly jev: JevEvaluationPort;
}

/** Both built-in results from one batch evaluation, in fixed display order. */
export interface BuiltInBatchReview {
  readonly scopeCreep: BuiltInReviewResult;
  readonly complexity: BuiltInReviewResult;
}
