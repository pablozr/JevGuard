import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseUnifiedDiff } from "@jevguard/core";
import { JEV_MODEL } from "@jevguard/node-infra";
import type { ResponseObserver } from "../calibration/response-metadata";
import { parseArguments, type RunCommand } from "./args";
import { loadCorpus } from "./corpus";
import { createCoreRunner, createHostRunner, type ReviewRunner, ruleObservation } from "./hosts";
import { summarizeLatency } from "./metrics";
import { createObserver, checkCredential, createObservingPort } from "./ports";
import { buildHostSummary, buildReport, renderMarkdown, BENCHMARK_DISCLAIMER } from "./report";
import type { BenchmarkCase, CaseObservation, CorpusRule, HostCaseResult } from "./types";

async function main(): Promise<number> {
  const parsed = parseArguments(process.argv.slice(2));

  switch (parsed.status) {
    case "HELP":
      console.log(parsed.text);

      return 0;
    case "ERROR":
      console.error(`error: ${parsed.message}`);

      return 1;
    case "OK":
      return runBenchmark(parsed.command);
  }
}

interface SelectedCorpus {
  readonly rules: readonly CorpusRule[];
  readonly cases: readonly BenchmarkCase[];
}

async function runBenchmark(command: RunCommand): Promise<number> {
  const loaded = await loadCorpus(command.corpusDirectory);

  if (loaded.status === "INVALID") {
    console.error("error: the corpus failed validation; no credential or API call was made.");

    for (const code of loaded.codes) {
      console.error(`  - ${code}`);
    }

    return 1;
  }

  const selected = selectCases(loaded.corpus.cases, loaded.corpus.rules, command);

  if (typeof selected === "string") {
    console.error(`error: ${selected}`);

    return 1;
  }

  const probeCases = selectProbeCases(selected.cases, selected.rules, command.hostCases);
  const plannedRuns =
    selected.cases.length * command.repeat +
    probeCases.length * command.hosts.length * command.repeat;

  if (command.confirmLiveRuns !== String(plannedRuns)) {
    printPreflight(command, selected.cases.length, probeCases.length, plannedRuns);

    return 0;
  }

  const credential = await checkCredential();

  if (credential !== "AVAILABLE") {
    console.error("No usable TypeSafe API credential was found; no API call was made.");

    if (credential === "MISSING_CREDENTIAL") {
      console.error("Set TYPESAFE_API_KEY for CI or run: jevguard login");
    } else {
      console.error("The OS credential store could not be read. Retry jevguard login.");
    }

    return 1;
  }

  const observer = createObserver();
  const jev = createObservingPort(command.concurrency, observer);
  const now = new Date();
  const runId = formatRunId(now);

  console.log(`Corpus hash ${loaded.corpus.hash}`);
  console.log(`Planned reviews: ${plannedRuns}`);

  const accuracyRunner = createCoreRunner(jev);
  const observations = await runAccuracyPass(
    selected.cases,
    command.repeat,
    accuracyRunner,
    observer,
  );

  const hostMeasurements = [];

  for (const host of command.hosts) {
    const runner = createHostRunner(host, jev);
    const measured = await runHostPass(host, probeCases, command.repeat, runner, observer);

    hostMeasurements.push(
      buildHostSummary(
        host,
        measured.cases,
        summarizeLatency(measured.latencies),
        measured.inputTokens,
        measured.outputTokens,
        measured.responsesWithUsage,
        command.pricing,
      ),
    );
  }

  const usage = observer.snapshot();
  const report = buildReport({
    metadata: {
      runId,
      generatedAt: now.toISOString(),
      corpusHash: loaded.corpus.hash,
      requestedModel: JEV_MODEL,
      returnedModels: usage.returnedModels,
      repeat: command.repeat,
      hosts: command.hosts,
      probeCaseIds: probeCases.map((item) => item.id),
      pricing: command.pricing,
    },
    rules: selected.rules,
    observations,
    hostMeasurements,
  });

  const paths = {
    json: join(command.outputDirectory, `${runId}.json`),
    markdown: join(command.outputDirectory, `${runId}.md`),
  };

  await mkdir(command.outputDirectory, { recursive: true });
  await writeFile(paths.json, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(paths.markdown, renderMarkdown(report));

  logSummary(report, observations);

  console.log(`Report written: ${paths.json}`);
  console.log(`Report written: ${paths.markdown}`);

  const unavailable = observations.some(
    (item) => item.observed === "UNAVAILABLE" || item.observed === "SKIPPED",
  );

  return unavailable ? 1 : 0;
}

/**
 * Probe cases cover different rules instead of the first file alphabetically: one case
 * per rule in pack order (SECRETS-001 first, an `error` rule), up to the requested
 * count. A host probe is a whole review, so it is the expensive part of a run.
 */
function selectProbeCases(
  cases: readonly BenchmarkCase[],
  rules: readonly CorpusRule[],
  count: number,
): readonly BenchmarkCase[] {
  const probes: BenchmarkCase[] = [];

  for (const rule of rules) {
    const item = cases.find((candidate) => candidate.ruleId === rule.id);

    if (item !== undefined) {
      probes.push(item);
    }
  }

  return probes.slice(0, count);
}

function selectCases(
  cases: readonly BenchmarkCase[],
  rules: readonly CorpusRule[],
  command: RunCommand,
): SelectedCorpus | string {
  const known = new Set(rules.map((rule) => rule.id));
  const unknown = command.ruleIds.filter((id) => !known.has(id));

  if (unknown.length > 0) {
    return `unknown rule: ${unknown.join(", ")}`;
  }

  const filtered =
    command.ruleIds.length === 0
      ? cases
      : cases.filter((item) => command.ruleIds.includes(item.ruleId));
  const selected = filtered.slice(0, command.limit);
  const selectedRules = rules.filter((rule) => selected.some((item) => item.ruleId === rule.id));

  if (selected.length === 0) {
    return "no case matched the selection";
  }

  return { rules: selectedRules, cases: selected };
}

async function runAccuracyPass(
  cases: readonly BenchmarkCase[],
  repeat: number,
  runner: ReviewRunner,
  observer: ResponseObserver,
): Promise<readonly CaseObservation[]> {
  const observations: CaseObservation[] = [];

  for (const item of cases) {
    for (let round = 0; round < repeat; round += 1) {
      const turn = toTurn(item, round);
      const measured = await measure(observer, () => runner.review(turn, item.ruleId));
      const result =
        measured.failure === null
          ? ruleObservation(measured.value, item.ruleId)
          : { observed: "UNAVAILABLE" as const, probability: null, reason: measured.failure };

      observations.push({
        caseId: item.id,
        ruleId: item.ruleId,
        expected: item.expected,
        observed: result.observed,
        probability: result.probability,
        reason: result.reason,
        latencyMs: measured.latencyMs,
        inputTokens: measured.inputTokens,
        outputTokens: measured.outputTokens,
      });
    }
  }

  return observations;
}

interface HostPass {
  readonly cases: readonly HostCaseResult[];
  readonly latencies: readonly number[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly responsesWithUsage: number;
}

async function runHostPass(
  host: string,
  cases: readonly BenchmarkCase[],
  repeat: number,
  runner: ReviewRunner,
  observer: ResponseObserver,
): Promise<HostPass> {
  const results: HostCaseResult[] = [];
  const latencies: number[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let responsesWithUsage = 0;

  for (const item of cases) {
    for (let round = 0; round < repeat; round += 1) {
      const turn = toTurn(item, round);
      // A host review evaluates the whole pack, so the target rule is read from the
      // aggregate instead of being filtered before Jev as in the accuracy pass.
      const measured = await measure(observer, () => runner.review(turn, item.ruleId));
      const result =
        measured.failure === null
          ? ruleObservation(measured.value, item.ruleId)
          : { observed: "UNAVAILABLE" as const, probability: null, reason: measured.failure };

      latencies.push(measured.latencyMs);
      inputTokens += measured.inputTokens;
      outputTokens += measured.outputTokens;
      responsesWithUsage += measured.responsesWithUsage;
      results.push({
        caseId: item.id,
        ruleId: item.ruleId,
        observed: result.observed,
        probability: result.probability,
        reason: result.reason,
        latencyMs: measured.latencyMs,
        inputTokens: measured.inputTokens,
        outputTokens: measured.outputTokens,
      });
    }
  }

  console.log(`${host}: ${results.length} review(s) measured`);

  return { cases: results, latencies, inputTokens, outputTokens, responsesWithUsage };
}

interface Measured<T> {
  readonly value: T;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly responsesWithUsage: number;
  /** Typed reason when the review path itself failed; the raw error never leaves here. */
  readonly failure: string | null;
}

async function measure<T>(
  observer: ResponseObserver,
  action: () => Promise<T>,
): Promise<Measured<T>> {
  const before = observer.snapshot();
  const started = performance.now();
  let failure: string | null = null;
  let value: T;

  try {
    value = await action();
  } catch {
    value = undefined as T;
    failure = "BENCHMARK_RUN_FAILED";
  }

  const latencyMs = performance.now() - started;
  const after = observer.snapshot();

  return {
    value,
    latencyMs,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    responsesWithUsage: after.responsesWithUsage - before.responsesWithUsage,
    failure,
  };
}

function toTurn(item: BenchmarkCase, round: number) {
  const parsed = parseUnifiedDiff(item.diff);

  if (parsed.status !== "PARSED") {
    throw new Error("corpus validation guarantees a parsable diff");
  }

  return { id: `${item.id}#${round}`, task: item.task, files: parsed.files };
}

function logSummary(
  report: ReturnType<typeof buildReport>,
  observations: readonly CaseObservation[],
): void {
  const unavailable = observations.filter(
    (item) => item.observed === "UNAVAILABLE" || item.observed === "SKIPPED",
  ).length;

  console.log(
    `Benchmark complete: ${observations.length} case evaluation(s), ${unavailable} without a verdict.`,
  );
  console.log(BENCHMARK_DISCLAIMER);

  for (const rule of report.rules) {
    console.log(
      `${rule.ruleId}: exact ${rule.exact}/${rule.cases}, false alarm ${rule.confusion.falseAlarm}/${rule.cleanCases}, missed violation ${rule.confusion.falseNegative}, missed WARN ${rule.confusion.missedWarning}, p50 ${describeMs(rule.latency.p50Ms)}`,
    );
  }

  for (const host of report.hostMeasurements) {
    console.log(
      `${host.host}: ${host.reviews} review(s), p50 ${describeMs(host.latency.p50Ms)}, p90 ${describeMs(host.latency.p90Ms)}, ${describeTokens(host.meanInputTokensPerReview)} input tokens/review, US$ ${host.costUsdPerReview === null ? "—" : host.costUsdPerReview.toFixed(6)}/review`,
    );
  }
}

function printPreflight(
  command: RunCommand,
  accuracyCases: number,
  probeCases: number,
  plannedRuns: number,
): void {
  console.log("Preflight only: no live API call will be made.");
  console.log(`Accuracy cases: ${accuracyCases}`);
  console.log(`Repeat per case: ${command.repeat}`);
  console.log(`Hosts: ${command.hosts.length === 0 ? "none" : command.hosts.join(", ")}`);
  console.log(`Host probe cases: ${probeCases}`);
  console.log(`Planned reviews: ${plannedRuns}`);
  console.log(`To run the live benchmark, pass exactly: --confirm-live-runs ${plannedRuns}`);
}

function describeMs(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function describeTokens(value: number | null): string {
  return value === null ? "—" : Math.round(value).toString();
}

function formatRunId(date: Date): string {
  const parts = [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ];

  return `bench-${parts.slice(0, 3).join("")}-${parts.slice(3).join("")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];

  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  process.exitCode = await main();
}
