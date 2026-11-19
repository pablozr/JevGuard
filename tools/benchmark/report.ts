import { costOf, summarizeRule } from "./metrics";
import type {
  BenchmarkReport,
  CaseObservation,
  CorpusRule,
  HostCaseResult,
  HostSummary,
  SafeRunMetadata,
} from "./types";

export const BENCHMARK_DISCLAIMER =
  "Author-labeled synthetic corpus; measures agreement with the labels, not production ground truth.";

export interface ReportInput {
  readonly metadata: SafeRunMetadata;
  readonly rules: readonly CorpusRule[];
  readonly observations: readonly CaseObservation[];
  readonly hostMeasurements: readonly HostSummary[];
}

export function buildReport(input: ReportInput): BenchmarkReport {
  return {
    schemaVersion: 1,
    disclaimer: BENCHMARK_DISCLAIMER,
    metadata: input.metadata,
    rules: input.rules.map((rule) =>
      summarizeRule(
        rule,
        input.observations.filter((item) => item.ruleId === rule.id),
      ),
    ),
    hostMeasurements: input.hostMeasurements,
    observations: input.observations,
  };
}

/**
 * The Markdown report is written to be cited: every table names the measured counts,
 * and the methodology and limitations travel with the numbers instead of living only
 * in the docs page.
 */
export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  const metadata = report.metadata;
  const caseCount = report.rules.reduce((total, rule) => total + rule.cases, 0);

  lines.push(`# JevGuard public benchmark — ${metadata.generatedAt.slice(0, 10)}`, "");
  lines.push(`> ${report.disclaimer}`, "");
  lines.push(
    "## Methodology",
    "",
    `- Corpus: \`${metadata.corpusHash}\`, ${caseCount} author-labeled cases across the rules of the initial pack.`,
    `- Model requested: \`${metadata.requestedModel}\`; models that answered: ${describeModels(metadata.returnedModels)}.`,
    `- Repeat per case: ${metadata.repeat}.`,
    "- Accuracy pass: one Jev rule evaluation per case, through the rule lane the OpenCode and Claude Code plugins call.",
    `- Host measurements: a complete review (repository rules plus the built-in batch) through each host's review entry, on ${metadata.probeCaseIds.length} probe cases.`,
    `- Price used for cost: ${metadata.pricing.source}.`,
    "- No task, diff, finding, path, or credential is written to this report.",
    "",
    "## Accuracy per rule",
    "",
    "| Rule | Severity | Cases | Exact | False alarm | Hard FP | Missed violation | Missed WARN | Over-fire | p50 review |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const rule of report.rules) {
    lines.push(
      `| ${rule.ruleId} | ${rule.severity} | ${rule.cases} | ${ratio(rule.exact, rule.cases)} | ${ratio(rule.confusion.falseAlarm, rule.cleanCases)} | ${rule.confusion.hardFalsePositive} | ${rule.confusion.falseNegative} | ${rule.confusion.missedWarning} | ${rule.confusion.overFire} | ${describeMs(rule.latency.p50Ms)} |`,
    );
  }

  lines.push(
    "",
    "False alarm counts a clean case (expected PASS) that reached WARN or FAIL; Hard FP counts a clean case that reached FAIL. A warning-severity rule cannot reach FAIL, so its Hard FP is 0 by construction, not a measured result. Missed violation is an expected FAIL that reached PASS. Missed WARN and Over-fire describe the probability band of a borderline case.",
    "",
    "## Cost and latency per host",
    "",
    "| Host | Reviews | p50 | p90 | Input tokens / review | Output tokens / review | Cost / review (US$) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  );

  for (const host of report.hostMeasurements) {
    lines.push(
      `| ${host.host} | ${host.reviews} | ${describeMs(host.latency.p50Ms)} | ${describeMs(host.latency.p90Ms)} | ${describeTokens(host.meanInputTokensPerReview)} | ${describeTokens(host.meanOutputTokensPerReview)} | ${describeCost(host.costUsdPerReview)} |`,
    );
  }

  lines.push(
    "",
    "Cost uses the list price above, which is not carried by the API response; tokens are measured from each response's usage envelope.",
    "",
    "## Limitations",
    "",
    "- The labels are the author's intent for short, synthetic patches; they are not ground truth and do not estimate production accuracy.",
    "- Cases are written against the same rule wording the product sends, which can overstate agreement.",
    "- WARN is a probability band, not a deterministic label: a borderline case can legitimately move between PASS and WARN on another run.",
    "- The rule lane is shared by both hosts; the host table measures the wrapper each host runs (worker handoff or in-process runtime), not the host's patch capture.",
    "- Latency is wall-clock time around the review call with one review in flight, measured on one machine and one network in a single run; another machine, network, or load changes it, so it does not reproduce elsewhere.",
    "",
    "## Cases",
    "",
    "| Case | Rule | Expected | Observed | Probability | Latency |",
    "| --- | --- | --- | --- | ---: | ---: |",
  );

  for (const item of report.observations) {
    lines.push(
      `| ${item.caseId} | ${item.ruleId} | ${item.expected} | ${item.observed}${item.reason === null ? "" : ` (${item.reason})`} | ${item.probability === null ? "—" : item.probability.toFixed(2)} | ${describeMs(item.latencyMs)} |`,
    );
  }

  if (report.hostMeasurements.length > 0) {
    lines.push(
      "",
      "### Host probe cases",
      "",
      "| Host | Case | Rule | Observed | Probability |",
      "| --- | --- | --- | --- | ---: |",
    );

    for (const host of report.hostMeasurements) {
      for (const item of host.cases) {
        lines.push(
          `| ${host.host} | ${item.caseId} | ${item.ruleId} | ${item.observed}${item.reason === null ? "" : ` (${item.reason})`} | ${item.probability === null ? "—" : item.probability.toFixed(2)} |`,
        );
      }
    }
  }

  lines.push("");

  return lines.join("\n");
}

function ratio(count: number, total: number): string {
  if (total <= 0) return "—";

  return `${count}/${total} (${Math.round((count / total) * 100)}%)`;
}

function describeModels(models: Readonly<Record<string, number>>): string {
  const entries = Object.entries(models);

  if (entries.length === 0) return "none reported";

  return entries.map(([model, count]) => `\`${model}\` ×${count}`).join(", ");
}

function describeMs(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function describeTokens(value: number | null): string {
  return value === null ? "—" : Math.round(value).toString();
}

function describeCost(value: number | null): string {
  return value === null ? "—" : value.toFixed(6);
}

export function buildHostSummary(
  host: string,
  cases: readonly HostCaseResult[],
  latency: HostSummary["latency"],
  inputTokens: number,
  outputTokens: number,
  responsesWithUsage: number,
  pricing: {
    readonly inputUsdPerMillionTokens: number;
    readonly outputUsdPerMillionTokens: number;
  },
): HostSummary {
  const reviews = cases.length;

  return {
    host,
    cases,
    reviews,
    latency,
    inputTokens,
    outputTokens,
    responsesWithUsage,
    meanInputTokensPerReview: reviews === 0 ? null : inputTokens / reviews,
    meanOutputTokensPerReview: reviews === 0 ? null : outputTokens / reviews,
    costUsdPerReview:
      reviews === 0
        ? null
        : costOf(
            inputTokens / reviews,
            outputTokens / reviews,
            pricing.inputUsdPerMillionTokens,
            pricing.outputUsdPerMillionTokens,
          ),
  };
}
