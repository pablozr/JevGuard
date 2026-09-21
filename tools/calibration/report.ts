import {
  buildAuthorLabelCounts,
  buildDistribution,
  buildGateStateMatrix,
  buildOperatingPoints,
  buildRepeats,
  buildThresholdSweep,
  countOperational,
  operatingPointsFor,
} from "./metrics";
import type {
  CalibrationCheckId,
  CalibrationReport,
  CheckReport,
  CheckScoreSample,
  DerivedMetrics,
  HistogramReport,
  OperationalFailure,
  QuantileSummary,
  RunSelectionSummary,
  SafeUsageTotals,
} from "./types";

export const SYNTHETIC_DISCLAIMER = "Synthetic author-label calibration signal; not ground truth.";

const MARKDOWN_PREFACE = [
  "> **Synthetic author-label calibration signal; not ground truth.**",
  "",
  "These results compare Jev probabilities with deterministic labels assigned by the",
  "synthetic scenario author. They do not establish factual ground truth or estimate",
  "production accuracy. Generated cases can share assumptions with the check wording",
  "and may overstate agreement. Use this report to find gross separation, threshold",
  "sensitivity, and cases requiring human review. Do not change production thresholds",
  "automatically.",
].join("\n");

export interface ReportInput {
  readonly runId: string;
  readonly generatedAt: string;
  readonly seed: string;
  readonly corpusHash: string;
  readonly questionsHash: string;
  readonly requestedModel: string;
  readonly returnedModels: Readonly<Record<string, number>>;
  readonly usage: SafeUsageTotals;
  readonly selection: RunSelectionSummary;
  readonly scopeSamples: readonly CheckScoreSample[];
  readonly complexitySamples: readonly CheckScoreSample[];
}

export function buildReport(input: ReportInput): CalibrationReport {
  return {
    schemaVersion: 1,
    disclaimer: SYNTHETIC_DISCLAIMER,
    metadata: {
      runId: input.runId,
      generatedAt: input.generatedAt,
      dataset: SYNTHETIC_DISCLAIMER,
      seed: input.seed,
      corpusHash: input.corpusHash,
      questionsHash: input.questionsHash,
      requestedModel: input.requestedModel,
      returnedModels: input.returnedModels,
      usage: input.usage,
      selection: input.selection,
    },
    checks: {
      scopeCreep: buildCheckReport("scopeCreep", input.scopeSamples),
      complexity: buildCheckReport("complexity", input.complexitySamples),
    },
  };
}

export function buildCheckReport(
  check: CalibrationCheckId,
  samples: readonly CheckScoreSample[],
): CheckReport {
  const points = operatingPointsFor(check);
  const primaryThreshold = points[0]?.threshold ?? 0.4;
  const unavailable: OperationalFailure[] = samples
    .filter((sample) => sample.probability === null)
    .map((sample) => ({
      fixtureId: sample.fixtureId,
      check,
      reason: sample.reason ?? "UNKNOWN",
    }));

  return {
    check,
    operational: countOperational(samples),
    authorLabelCounts: buildAuthorLabelCounts(samples),
    operatingPoints: buildOperatingPoints(check, samples),
    gateStateMatrix: buildGateStateMatrix(samples),
    thresholdSweep: buildThresholdSweep(
      samples,
      points.map((point) => point.threshold),
    ),
    distribution: buildDistribution(samples),
    repeats: buildRepeats(samples, primaryThreshold),
    unavailable,
  };
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function formatSummary(summary: QuantileSummary | null): string {
  if (summary === null) {
    return "n/a";
  }

  return [
    `n=${summary.count}`,
    `min=${formatMetric(summary.min)}`,
    `p25=${formatMetric(summary.p25)}`,
    `p50=${formatMetric(summary.p50)}`,
    `p75=${formatMetric(summary.p75)}`,
    `max=${formatMetric(summary.max)}`,
    `mean=${formatMetric(summary.mean)}`,
  ].join(" | ");
}

function renderHistogram(histogram: HistogramReport): readonly string[] {
  return histogram.bins.map(
    (bin, index) =>
      `| [${formatMetric(bin.lowerInclusive)}, ${formatMetric(bin.upperBound)}${bin.includesUpperBound ? "]" : ")"} | ${histogram.counts[index] ?? 0} |`,
  );
}

function renderDerived(metrics: DerivedMetrics): string {
  return [
    `P=${formatMetric(metrics.precision)}`,
    `R=${formatMetric(metrics.recall)}`,
    `Sp=${formatMetric(metrics.specificity)}`,
    `F1=${formatMetric(metrics.f1)}`,
  ].join(" ");
}

function renderCheck(report: CheckReport): readonly string[] {
  const lines: string[] = [];
  const operational = report.operational;

  lines.push(`## ${report.check}`, "");
  lines.push(
    `- Attempted: ${operational.attempted}`,
    `- Evaluated: ${operational.evaluated}`,
    `- Unavailable: ${operational.unavailable}`,
    `- Skipped: ${operational.skipped}`,
    `- Availability rate: ${formatMetric(operational.availabilityRate)}`,
    "",
  );

  lines.push("### Operating-point agreement with synthetic author labels", "");
  lines.push("| threshold | point | TP | FP | TN | FN | metrics |");
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | --- |");

  for (const point of report.operatingPoints) {
    const matrix = point.matrix;

    lines.push(
      `| ${formatMetric(point.threshold)} | ${point.label} | ${matrix.truePositive} | ${matrix.falsePositive} | ${matrix.trueNegative} | ${matrix.falseNegative} | ${renderDerived(point.metrics)} |`,
    );
  }

  lines.push("", "### Author label by runtime gate state", "");
  lines.push("| author label | gate state | count |");
  lines.push("| --- | --- | ---: |");

  for (const row of report.gateStateMatrix) {
    lines.push(`| ${row.authorLabel} | ${row.outcome} | ${row.count} |`);
  }

  lines.push("", "### Diagnostic threshold sweep (no recommendation)", "");
  lines.push("| threshold | TP | FP | TN | FN | precision | recall | specificity | F1 |");
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

  for (const row of report.thresholdSweep) {
    const matrix = row.matrix;
    const metrics = row.metrics;

    lines.push(
      `| ${formatMetric(row.threshold)} | ${matrix.truePositive} | ${matrix.falsePositive} | ${matrix.trueNegative} | ${matrix.falseNegative} | ${formatMetric(metrics.precision)} | ${formatMetric(metrics.recall)} | ${formatMetric(metrics.specificity)} | ${formatMetric(metrics.f1)} |`,
    );
  }

  lines.push("", "### Distribution", "");
  lines.push(`- Overall: ${formatSummary(report.distribution.overall)}`);
  lines.push(`- Author VIOLATION: ${formatSummary(report.distribution.byAuthorLabel.violation)}`);
  lines.push(
    `- Author NO_VIOLATION: ${formatSummary(report.distribution.byAuthorLabel.noViolation)}`,
    "",
  );
  lines.push("| bin | count |");
  lines.push("| --- | ---: |");
  lines.push(...renderHistogram(report.distribution.histogram));

  if (report.repeats.some((repeat) => repeat.sampleCount > 1)) {
    lines.push("", "### Repeat variability", "");
    lines.push("| fixture | check | n | mean | min | max | stddev | crossings | flip rate |");
    lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

    for (const repeat of report.repeats) {
      lines.push(
        `| ${repeat.fixtureId} | ${repeat.check} | ${repeat.sampleCount} | ${formatMetric(repeat.mean)} | ${formatMetric(repeat.min)} | ${formatMetric(repeat.max)} | ${formatMetric(repeat.standardDeviation)} | ${repeat.thresholdCrossings} | ${formatMetric(repeat.flipRate)} |`,
      );
    }
  }

  if (report.unavailable.length > 0) {
    lines.push("", "### Unavailable evaluations (excluded from semantic metrics)", "");
    lines.push("| fixture | check | reason |");
    lines.push("| --- | --- | --- |");

    for (const failure of report.unavailable) {
      lines.push(`| ${failure.fixtureId} | ${failure.check} | ${failure.reason} |`);
    }
  }

  lines.push("");

  return lines;
}

export function renderMarkdown(report: CalibrationReport): string {
  const metadata = report.metadata;
  const selection = metadata.selection;
  const lines: string[] = [];

  lines.push("# JevGuard synthetic calibration report", "");
  lines.push(MARKDOWN_PREFACE, "");
  lines.push(
    `Run \`${metadata.runId}\` generated ${metadata.generatedAt}.`,
    `Corpus \`${metadata.corpusHash}\` from seed \`${metadata.seed}\`; questions hash \`${metadata.questionsHash}\`.`,
    `Requested model \`${metadata.requestedModel}\`; returned models: ${
      Object.keys(metadata.returnedModels).length === 0
        ? "none observed"
        : Object.entries(metadata.returnedModels)
            .map(([model, count]) => `${model} (${count})`)
            .join(", ")
    }.`,
    `Tokens: input ${metadata.usage.inputTokens}, output ${metadata.usage.outputTokens} across ${metadata.usage.responsesWithUsage} responses with usage.`,
    "",
  );
  lines.push("## Selection", "");
  lines.push(
    `- Fixtures available: ${selection.totalFixtures}`,
    `- Fixtures selected: ${selection.selectedFixtures}`,
    `- Repeat: ${selection.repeat}`,
    `- Planned logical calls: ${selection.plannedLogicalCalls}`,
    `- Concurrency: ${selection.concurrency}`,
    `- Difficulty filter: ${selection.difficultyFilter ?? "none"}`,
    `- Category filters: ${selection.categoryFilters.length === 0 ? "none" : selection.categoryFilters.join(", ")}`,
    "",
  );
  lines.push(...renderCheck(report.checks.scopeCreep));
  lines.push(...renderCheck(report.checks.complexity));
  lines.push(
    "## Interpretation limits",
    "",
    "Agreement with synthetic author labels is directional only. A later calibration",
    "set should use manually reviewed, representative real turns before any threshold",
    "changes are considered. No threshold is recommended or applied by this report.",
    "",
  );

  return `${lines.join("\n")}\n`;
}
