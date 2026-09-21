import {
  DEFAULT_EVIDENCE_POLICY,
  buildBuiltInBatchRequest,
  createFifoJevPort,
  evaluateBuiltIns,
  type BuiltInReviewResult,
  type JevEvaluationPort,
  type Turn,
} from "@jevguard/core";
import {
  createCredentialProvider,
  createJevTransport,
  createKeyringCredentialStore,
  createProcessEnvironment,
  createTypeSafeSystemOneClient,
} from "@jevguard/opencode-adapter";
import { MAX_PLANNED_CALLS } from "./args";
import { hashFixtures, stableHash } from "./fixture-io";
import { buildReport, renderMarkdown } from "./report";
import {
  createObservingClientFactory,
  createResponseObserver,
  type ResponseObserver,
} from "./response-metadata";
import type {
  CalibrationCategory,
  CalibrationCheckId,
  CalibrationDifficulty,
  CalibrationReport,
  CheckScoreSample,
  RunSelectionSummary,
  SafeUsageTotals,
  SyntheticCalibrationFixture,
} from "./types";

export type CredentialCheck = "AVAILABLE" | "MISSING_CREDENTIAL" | "STORE_READ_FAILURE";

export interface CalibrationRunRequest {
  readonly fixtures: readonly SyntheticCalibrationFixture[];
  readonly limit: number;
  readonly concurrency: number;
  readonly repeat: number;
  readonly difficulty: CalibrationDifficulty | null;
  readonly categories: readonly CalibrationCategory[];
  readonly confirmLiveApi: string | null;
  readonly seed: string;
  readonly requestedModel: string;
  readonly outputDir: string;
}

export interface CalibrationRunDependencies {
  readonly createPort: (concurrency: number, observer: ResponseObserver) => JevEvaluationPort;
  readonly checkCredential: () => Promise<CredentialCheck>;
  readonly now: () => Date;
  readonly runId: string;
  readonly writeFile: (path: string, content: string) => Promise<void>;
  readonly log: (line: string) => void;
}

export interface CalibrationRunResult {
  readonly status: "NOT_CONFIRMED" | "ABORTED" | "COMPLETED";
  readonly exitCode: number;
  readonly plannedLogicalCalls: number;
  readonly report: CalibrationReport | null;
  readonly reportPaths: { readonly json: string; readonly markdown: string } | null;
}

/**
 * Composes the real runtime used by the plugin: the concrete credential provider,
 * the TypeSafe transport with a safe observation wrapper, and the shared FIFO
 * concurrency limit. No key, task, diff, or raw response leaves this composition.
 */
export function createLiveCalibrationPort(
  concurrency: number,
  observer: ResponseObserver,
): JevEvaluationPort {
  const credentials = createCredentialProvider({
    environment: createProcessEnvironment(),
    store: createKeyringCredentialStore(),
  });

  return createFifoJevPort(
    createJevTransport({
      credentials,
      createClient: createObservingClientFactory(createTypeSafeSystemOneClient, observer),
    }),
    { maxConcurrency: concurrency },
  );
}

export function selectFixtures(
  fixtures: readonly SyntheticCalibrationFixture[],
  difficulty: CalibrationDifficulty | null,
  categories: readonly CalibrationCategory[],
  limit: number,
): readonly SyntheticCalibrationFixture[] {
  const filtered = fixtures.filter((fixture) => {
    if (difficulty !== null && fixture.difficulty !== difficulty) {
      return false;
    }

    return categories.length === 0 || categories.some((category) => category === fixture.category);
  });

  return filtered.slice(0, limit);
}

/**
 * Runs the calibration flow. With no exact `--confirm-live-api` match it prints only
 * the safe preflight plan and performs zero credential or API calls; with a missing
 * credential it prints only a login instruction. The one batch per fixture goes
 * through the real `evaluateBuiltIns`, so evidence safety, question wording, and the
 * fixed gates are never duplicated here.
 */
export async function runCalibration(
  request: CalibrationRunRequest,
  dependencies: CalibrationRunDependencies,
): Promise<CalibrationRunResult> {
  const selected = selectFixtures(
    request.fixtures,
    request.difficulty,
    request.categories,
    request.limit,
  );
  const plannedLogicalCalls = selected.length * request.repeat;

  if (selected.length === 0) {
    dependencies.log("No fixtures selected; nothing to run.");

    return aborted(plannedLogicalCalls);
  }

  if (plannedLogicalCalls > MAX_PLANNED_CALLS) {
    dependencies.log(
      `Planned calls ${plannedLogicalCalls} exceed the hard cap of ${MAX_PLANNED_CALLS}.`,
    );

    return aborted(plannedLogicalCalls);
  }

  if (request.confirmLiveApi !== String(plannedLogicalCalls)) {
    logPreflight(dependencies, request, selected.length, plannedLogicalCalls);

    return {
      status: "NOT_CONFIRMED",
      exitCode: 0,
      plannedLogicalCalls,
      report: null,
      reportPaths: null,
    };
  }

  const credential = await dependencies.checkCredential();

  if (credential !== "AVAILABLE") {
    logCredentialInstruction(dependencies, credential);

    return aborted(plannedLogicalCalls);
  }

  const observer = createResponseObserver();
  const port = dependencies.createPort(request.concurrency, observer);
  const scopeSamples: CheckScoreSample[] = [];
  const complexitySamples: CheckScoreSample[] = [];

  const tasks: Promise<void>[] = [];

  for (const fixture of selected) {
    for (let repeat = 0; repeat < request.repeat; repeat += 1) {
      tasks.push(evaluateFixture(fixture, repeat, port, scopeSamples, complexitySamples));
    }
  }

  await Promise.all(tasks);

  const usage = observer.snapshot();
  const report = buildReport({
    runId: dependencies.runId,
    generatedAt: dependencies.now().toISOString(),
    seed: request.seed,
    corpusHash: hashFixtures(request.fixtures),
    questionsHash: questionsHash(),
    requestedModel: request.requestedModel,
    returnedModels: usage.returnedModels,
    usage: toUsageTotals(usage.inputTokens, usage.outputTokens, usage.responsesWithUsage),
    selection: summarizeSelection(
      request.fixtures.length,
      selected,
      request.repeat,
      request.concurrency,
      request.difficulty,
      request.categories,
      plannedLogicalCalls,
    ),
    scopeSamples,
    complexitySamples,
  });

  const reportPaths = {
    json: `${request.outputDir}/report.json`,
    markdown: `${request.outputDir}/report.md`,
  };

  await dependencies.writeFile(reportPaths.json, `${JSON.stringify(report, null, 2)}\n`);
  await dependencies.writeFile(reportPaths.markdown, renderMarkdown(report));

  const exitCode = incompleteExitCode(report);

  logSummary(dependencies, report, exitCode);

  return { status: "COMPLETED", exitCode, plannedLogicalCalls, report, reportPaths };
}

async function evaluateFixture(
  fixture: SyntheticCalibrationFixture,
  repeat: number,
  port: JevEvaluationPort,
  scopeSamples: CheckScoreSample[],
  complexitySamples: CheckScoreSample[],
): Promise<void> {
  const turn: Turn = { id: `${fixture.id}#${repeat}`, task: fixture.task, files: fixture.files };
  const result = await evaluateBuiltIns(
    { turn, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
    { jev: port },
  );

  scopeSamples.push(toSample(fixture, "scopeCreep", repeat, result.scopeCreep));
  complexitySamples.push(toSample(fixture, "complexity", repeat, result.complexity));
}

function toSample(
  fixture: SyntheticCalibrationFixture,
  check: CalibrationCheckId,
  repeat: number,
  result: BuiltInReviewResult,
): CheckScoreSample {
  const base = {
    fixtureId: fixture.id,
    check,
    repeat,
    category: fixture.category,
    difficulty: fixture.difficulty,
    authorLabel: check === "scopeCreep" ? fixture.expected.scopeCreep : fixture.expected.complexity,
  };

  if (result.outcome === "PASS" || result.outcome === "WARN" || result.outcome === "FAIL") {
    return {
      ...base,
      outcome: result.outcome,
      probability: result.violationProbability,
      reason: null,
    };
  }

  return { ...base, outcome: result.outcome, probability: null, reason: result.reason };
}

function toUsageTotals(
  inputTokens: number,
  outputTokens: number,
  responsesWithUsage: number,
): SafeUsageTotals {
  return { inputTokens, outputTokens, responsesWithUsage };
}

function questionsHash(): string {
  const request = buildBuiltInBatchRequest("", { files: [], diff: "" });

  return stableHash(JSON.stringify(request.questions));
}

function summarizeSelection(
  totalFixtures: number,
  selected: readonly SyntheticCalibrationFixture[],
  repeat: number,
  concurrency: number,
  difficulty: CalibrationDifficulty | null,
  categories: readonly CalibrationCategory[],
  plannedLogicalCalls: number,
): RunSelectionSummary {
  const selectedByQuadrant = {
    noViolationNoViolation: 0,
    violationNoViolation: 0,
    noViolationViolation: 0,
    violationViolation: 0,
  };
  const selectedByDifficulty = { clear: 0, borderline: 0 };

  for (const fixture of selected) {
    const scope = fixture.expected.scopeCreep;
    const complexity = fixture.expected.complexity;

    if (scope === "NO_VIOLATION" && complexity === "NO_VIOLATION") {
      selectedByQuadrant.noViolationNoViolation += 1;
    } else if (scope === "VIOLATION" && complexity === "NO_VIOLATION") {
      selectedByQuadrant.violationNoViolation += 1;
    } else if (scope === "NO_VIOLATION" && complexity === "VIOLATION") {
      selectedByQuadrant.noViolationViolation += 1;
    } else {
      selectedByQuadrant.violationViolation += 1;
    }

    if (fixture.difficulty === "clear") {
      selectedByDifficulty.clear += 1;
    } else {
      selectedByDifficulty.borderline += 1;
    }
  }

  return {
    totalFixtures,
    selectedFixtures: selected.length,
    repeat,
    plannedLogicalCalls,
    concurrency,
    difficultyFilter: difficulty,
    categoryFilters: categories,
    selectedByQuadrant,
    selectedByDifficulty,
  };
}

function incompleteExitCode(report: CalibrationReport): number {
  const checks = [report.checks.scopeCreep.operational, report.checks.complexity.operational];
  const incomplete = checks.some((counts) => counts.unavailable > 0 || counts.skipped > 0);

  return incomplete ? 1 : 0;
}

function logPreflight(
  dependencies: CalibrationRunDependencies,
  request: CalibrationRunRequest,
  selectedCount: number,
  plannedLogicalCalls: number,
): void {
  dependencies.log("Preflight only: no live API call will be made.");
  dependencies.log(`Fixtures selected: ${selectedCount}`);
  dependencies.log(`Repeat: ${request.repeat}`);
  dependencies.log(`Concurrency: ${request.concurrency}`);
  dependencies.log(`Planned logical evaluations: ${plannedLogicalCalls}`);
  dependencies.log(
    `To run the live calibration, pass exactly: --confirm-live-api ${plannedLogicalCalls}`,
  );
}

function logCredentialInstruction(
  dependencies: CalibrationRunDependencies,
  credential: CredentialCheck,
): void {
  dependencies.log("No usable TypeSafe API credential was found; no API call was made.");

  if (credential === "MISSING_CREDENTIAL") {
    dependencies.log("Set TYPESAFE_API_KEY for CI or run: jevguard login");
  } else {
    dependencies.log("The OS credential store could not be read. Retry jevguard login.");
  }
}

function logSummary(
  dependencies: CalibrationRunDependencies,
  report: CalibrationReport,
  exitCode: number,
): void {
  const scope = report.checks.scopeCreep.operational;
  const complexity = report.checks.complexity.operational;
  const skipped = scope.skipped + complexity.skipped;

  dependencies.log(SYNTHETIC_SUMMARY_LABEL);
  dependencies.log(`Scope Creep evaluated: ${scope.evaluated}`);
  dependencies.log(`Complexity evaluated: ${complexity.evaluated}`);
  dependencies.log(`Unavailable: ${scope.unavailable + complexity.unavailable}`);

  if (skipped > 0) {
    dependencies.log(
      `Harness defect: ${skipped} selected fixture evaluation(s) were skipped unexpectedly.`,
    );
  }

  dependencies.log(`Report status: ${exitCode === 0 ? "complete" : "incomplete (nonzero exit)"}`);
}

const SYNTHETIC_SUMMARY_LABEL = "Synthetic author-label calibration signal; not ground truth.";

function aborted(plannedLogicalCalls: number): CalibrationRunResult {
  return {
    status: "ABORTED",
    exitCode: 1,
    plannedLogicalCalls,
    report: null,
    reportPaths: null,
  };
}
