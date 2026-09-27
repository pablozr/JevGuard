import type { ReviewOutcome, SkippedReason, UnavailableReason } from "../domain/types";
import type {
  ReportBuiltInCount,
  ReportEvaluationCoverage,
  ReportOutcomeTotals,
  ReportReasonCount,
  ReportRecord,
  ReportRuleBreakdown,
  ReviewReport,
} from "./types";

interface OutcomeAccumulator {
  pass: number;
  warn: number;
  fail: number;
  unavailable: number;
  skipped: number;
}

interface RuleAccumulator {
  readonly counts: OutcomeAccumulator;
  sliced: number;
}

/**
 * Pure, deterministic aggregation over parsed local review-history records. Outcome
 * totals, reason breakdowns, built-in counts, per-rule breakdowns, and timestamp
 * bounds are recomputed from `results`; the stored per-record `summary` is never
 * trusted. Rules are sorted by ID, checks by check ID, and reasons by code, so equal
 * history always produces byte-identical output. `skippedLineCount` is the number of
 * malformed lines the reader dropped.
 */
export function aggregateReviewHistory(
  records: readonly ReportRecord[],
  skippedLineCount: number,
): ReviewReport {
  const outcomes = emptyAccumulator();
  const unavailableReasons = new Map<UnavailableReason, number>();
  const skippedReasons = new Map<SkippedReason, number>();
  const builtIns = new Map<string, number>();
  const rules = new Map<string, RuleAccumulator>();
  const evaluation: {
    wholeEvaluations: number;
    slicedEvaluations: number;
    totalSliceJudgments: number;
  } = { wholeEvaluations: 0, slicedEvaluations: 0, totalSliceJudgments: 0 };
  let firstTimestamp: string | null = null;
  let lastTimestamp: string | null = null;

  for (const record of records) {
    firstTimestamp = earlier(firstTimestamp, record.timestamp);
    lastTimestamp = later(lastTimestamp, record.timestamp);

    for (const result of record.results) {
      countOutcome(outcomes, result.outcome);

      if (result.outcome === "UNAVAILABLE") {
        bump(unavailableReasons, result.reason);
      }

      if (result.outcome === "SKIPPED") {
        bump(skippedReasons, result.reason);
      }

      if (result.kind === "BUILT_IN") {
        bump(builtIns, result.checkId);
      }

      if (result.kind === "RULE" && result.ruleId !== null) {
        countRule(rules, result.ruleId, result.outcome, result.evidence);
      }

      if (result.kind === "RULE" && result.evidence !== undefined) {
        countEvidence(evaluation, result.evidence.mode, result.evidence.sliceJudgments.length);
      }
    }
  }

  return {
    entryCount: records.length,
    skippedLineCount,
    firstTimestamp,
    lastTimestamp,
    outcomes: finalizeAccumulator(outcomes),
    unavailableReasons: sortedReasons(unavailableReasons),
    skippedReasons: sortedReasons(skippedReasons),
    builtIns: sortedBuiltIns(builtIns),
    rules: sortedRules(rules),
    evaluation: finalizeEvaluation(evaluation),
  };
}

function emptyAccumulator(): OutcomeAccumulator {
  return { pass: 0, warn: 0, fail: 0, unavailable: 0, skipped: 0 };
}

function countOutcome(counts: OutcomeAccumulator, outcome: ReviewOutcome): void {
  switch (outcome) {
    case "PASS":
      counts.pass += 1;
      return;
    case "WARN":
      counts.warn += 1;
      return;
    case "FAIL":
      counts.fail += 1;
      return;
    case "UNAVAILABLE":
      counts.unavailable += 1;
      return;
    case "SKIPPED":
      counts.skipped += 1;
      return;
  }
}

function countRule(
  rules: Map<string, RuleAccumulator>,
  ruleId: string,
  outcome: ReviewOutcome,
  evidence: { readonly mode: "WHOLE" | "SLICED" } | undefined,
): void {
  const accumulator = rules.get(ruleId) ?? { counts: emptyAccumulator(), sliced: 0 };

  countOutcome(accumulator.counts, outcome);

  if (evidence?.mode === "SLICED") {
    accumulator.sliced += 1;
  }

  rules.set(ruleId, accumulator);
}

function countEvidence(
  coverage: { wholeEvaluations: number; slicedEvaluations: number; totalSliceJudgments: number },
  mode: "WHOLE" | "SLICED",
  sliceJudgmentCount: number,
): void {
  if (mode === "WHOLE") {
    coverage.wholeEvaluations += 1;
    return;
  }

  coverage.slicedEvaluations += 1;
  coverage.totalSliceJudgments += sliceJudgmentCount;
}

function finalizeAccumulator(counts: OutcomeAccumulator): ReportOutcomeTotals {
  return {
    pass: counts.pass,
    warn: counts.warn,
    fail: counts.fail,
    unavailable: counts.unavailable,
    skipped: counts.skipped,
    total: counts.pass + counts.warn + counts.fail + counts.unavailable + counts.skipped,
  };
}

function finalizeEvaluation(coverage: {
  wholeEvaluations: number;
  slicedEvaluations: number;
  totalSliceJudgments: number;
}): ReportEvaluationCoverage {
  return { ...coverage };
}

function bump<Key extends string>(map: Map<Key, number>, key: Key): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedReasons<Reason extends string>(
  map: ReadonlyMap<Reason, number>,
): readonly ReportReasonCount<Reason>[] {
  return [...map.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => compareStrings(left.reason, right.reason));
}

function sortedBuiltIns(map: ReadonlyMap<string, number>): readonly ReportBuiltInCount[] {
  return [...map.entries()]
    .map(([checkId, count]) => ({ checkId, count }))
    .sort((left, right) => compareStrings(left.checkId, right.checkId));
}

function sortedRules(map: ReadonlyMap<string, RuleAccumulator>): readonly ReportRuleBreakdown[] {
  return [...map.entries()]
    .map(([ruleId, accumulator]) => ({
      ruleId,
      counts: finalizeAccumulator(accumulator.counts),
      slicedRuleCount: accumulator.sliced,
    }))
    .sort((left, right) => compareStrings(left.ruleId, right.ruleId));
}

function earlier(current: string | null, candidate: string): string {
  return current === null || candidate < current ? candidate : current;
}

function later(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  return left > right ? 1 : 0;
}
