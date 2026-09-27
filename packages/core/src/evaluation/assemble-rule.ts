import type {
  EvidenceMode,
  GateConfig,
  GateResult,
  ParsedRule,
  RuleEvidenceMetadata,
  RuleReviewContext,
  RuleReviewResult,
  RuleSliceJudgment,
  RuleSliceSummary,
  SemanticVerdict,
} from "../domain/types";
import type { EvidenceSlice } from "../evidence/types";
import { evaluateGate } from "../gate/evaluate-gate";
import type { JevRuleEvaluationResult } from "../ports/types";

const VERDICT_RANK: Record<SemanticVerdict, number> = { PASS: 0, WARN: 1, FAIL: 2 };

/**
 * Assembles one planned rule's slices into a single deterministic rule result. Each
 * valid slice is gated independently; the merged verdict is the highest slice outcome
 * and the merged probability is the maximum across slices. Any slice that failed,
 * returned an invalid probability, or was never dispatched makes the rule
 * `UNAVAILABLE/JEV_FAILURE` with the failing index recorded, and no sibling
 * probability is presented as a semantic verdict. `PASS` requires every planned slice
 * to have evaluated below the warning threshold.
 */
export function assembleSlicedRuleResult(
  rule: ParsedRule,
  context: RuleReviewContext,
  slices: readonly EvidenceSlice[],
  evaluations: readonly JevRuleEvaluationResult[],
  gateConfig: GateConfig,
): RuleReviewResult {
  const summaries = slices.map(sliceSummary);
  const mode = evidenceMode(slices.length);
  const gates: GateResult[] = [];
  const judgments: RuleSliceJudgment[] = [];
  let failureIndex: number | null = null;

  for (let index = 0; index < slices.length; index += 1) {
    const slice = slices[index];
    const evaluation = evaluations[index];

    if (slice === undefined || evaluation === undefined || evaluation.status === "FAILED") {
      failureIndex = index;
      break;
    }

    const gate = evaluateGate(rule.severity, evaluation.noul.violationProbability, gateConfig);

    if (gate.outcome === "UNAVAILABLE") {
      failureIndex = index;
      break;
    }

    gates.push(gate);
    judgments.push({
      index: slice.index,
      probability: gate.violationProbability,
      outcome: gate.outcome,
    });
  }

  if (failureIndex !== null) {
    return {
      ...context,
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
      evidence: failedMetadata(mode, summaries, failureIndex),
    };
  }

  return {
    ...context,
    outcome: mergeVerdict(gates),
    violationProbability: maxProbability(gates),
    evidence: completeMetadata(mode, summaries, judgments),
  };
}

/** Coverage metadata for a rule whose slice budget was exceeded before any dispatch. */
export function overBudgetMetadata(slices: readonly EvidenceSlice[]): RuleEvidenceMetadata {
  const summaries = slices.map(sliceSummary);

  return {
    mode: "SLICED",
    plannedSliceCount: summaries.length,
    evaluatedSliceCount: 0,
    failedSliceCount: 0,
    notEvaluatedSliceCount: summaries.length,
    slices: summaries,
    sliceJudgments: [],
    failingSliceIndex: null,
    failureReason: "SLICE_LIMIT_EXCEEDED",
  };
}

function sliceSummary(slice: EvidenceSlice): RuleSliceSummary {
  return {
    index: slice.index,
    path: slice.path,
    kind: slice.kind,
    hunkOrdinal: slice.hunkOrdinal,
  };
}

function evidenceMode(sliceCount: number): EvidenceMode {
  return sliceCount === 1 ? "WHOLE" : "SLICED";
}

function mergeVerdict(gates: readonly GateResult[]): SemanticVerdict {
  let verdict: SemanticVerdict = "PASS";

  for (const gate of gates) {
    if (VERDICT_RANK[gate.outcome] > VERDICT_RANK[verdict]) {
      verdict = gate.outcome;
    }
  }

  return verdict;
}

function maxProbability(gates: readonly GateResult[]): number {
  return gates.reduce(
    (highest, gate) => Math.max(highest, gate.violationProbability),
    Number.NEGATIVE_INFINITY,
  );
}

function completeMetadata(
  mode: EvidenceMode,
  summaries: readonly RuleSliceSummary[],
  judgments: readonly RuleSliceJudgment[],
): RuleEvidenceMetadata {
  return {
    mode,
    plannedSliceCount: summaries.length,
    evaluatedSliceCount: summaries.length,
    failedSliceCount: 0,
    notEvaluatedSliceCount: 0,
    slices: summaries,
    sliceJudgments: judgments,
    failingSliceIndex: null,
    failureReason: null,
  };
}

function failedMetadata(
  mode: EvidenceMode,
  summaries: readonly RuleSliceSummary[],
  failingIndex: number,
): RuleEvidenceMetadata {
  return {
    mode,
    plannedSliceCount: summaries.length,
    evaluatedSliceCount: failingIndex,
    failedSliceCount: 1,
    notEvaluatedSliceCount: summaries.length - failingIndex - 1,
    slices: summaries,
    sliceJudgments: [],
    failingSliceIndex: failingIndex,
    failureReason: "JEV_FAILURE",
  };
}
