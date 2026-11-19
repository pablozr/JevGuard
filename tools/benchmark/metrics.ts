import type {
  CaseObservation,
  CorpusRule,
  LatencySummary,
  RuleConfusion,
  RuleSummary,
} from "./types";

/**
 * Every number here is a count over the observations the harness actually collected.
 * A case without a semantic judgment never counts as a pass or a failure: it counts as
 * unavailable and stays visible in the summary.
 */

export function summarizeRule(
  rule: CorpusRule,
  observations: readonly CaseObservation[],
): RuleSummary {
  let exact = 0;
  let evaluated = 0;
  let unavailable = 0;

  for (const item of observations) {
    if (item.observed === "PASS" || item.observed === "WARN" || item.observed === "FAIL") {
      evaluated += 1;
    } else {
      unavailable += 1;
    }

    if (item.observed === item.expected) {
      exact += 1;
    }
  }

  const confusion = confusionOf(observations);
  const latency = summarizeLatency(observations.map((item) => item.latencyMs));

  return {
    ruleId: rule.id,
    severity: rule.severity,
    cases: observations.length,
    evaluated,
    unavailable,
    cleanCases: observations.filter((item) => item.expected === "PASS").length,
    exact,
    exactRate: observations.length === 0 ? null : exact / observations.length,
    confusion,
    latency,
    inputTokens: sum(observations.map((item) => item.inputTokens)),
    outputTokens: sum(observations.map((item) => item.outputTokens)),
  };
}

export function confusionOf(observations: readonly CaseObservation[]): RuleConfusion {
  let falseAlarm = 0;
  let hardFalsePositive = 0;
  let falseNegative = 0;
  let missedWarning = 0;
  let overFire = 0;

  for (const item of observations) {
    if (item.expected === "PASS") {
      if (item.observed === "WARN" || item.observed === "FAIL") falseAlarm += 1;
      if (item.observed === "FAIL") hardFalsePositive += 1;
    }

    if (item.expected === "FAIL" && item.observed === "PASS") falseNegative += 1;
    if (item.expected === "WARN" && item.observed === "PASS") missedWarning += 1;
    if (item.expected === "WARN" && item.observed === "FAIL") overFire += 1;
  }

  return { falseAlarm, hardFalsePositive, falseNegative, missedWarning, overFire };
}

export function summarizeLatency(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { count: 0, meanMs: null, p50Ms: null, p90Ms: null, minMs: null, maxMs: null };
  }

  const sorted = [...values].sort((left, right) => left - right);

  return {
    count: sorted.length,
    meanMs: mean(sorted),
    p50Ms: quantile(sorted, 0.5),
    p90Ms: quantile(sorted, 0.9),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
}

/** Nearest-rank quantile over an already sorted sample. */
function quantile(sorted: readonly number[], fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));

  return sorted[index] ?? 0;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** List-price cost of the measured tokens, in US dollars. */
export function costOf(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMillionTokens: number,
  outputUsdPerMillionTokens: number,
): number {
  return (
    (inputTokens / 1_000_000) * inputUsdPerMillionTokens +
    (outputTokens / 1_000_000) * outputUsdPerMillionTokens
  );
}
