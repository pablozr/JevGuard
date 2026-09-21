import { pathToFileURL } from "node:url";
import {
  createCredentialProvider,
  createKeyringCredentialStore,
  createProcessEnvironment,
  JEV_MODEL,
} from "@jevguard/opencode-adapter";
import { type CalibrationCommand, parseArguments, type RunCommand } from "./args";
import { CALIBRATION_SEED } from "./fixture-catalog";
import {
  hashFixtures,
  readTextFile,
  runDirectory,
  serializeFixtures,
  writeTextFile,
} from "./fixture-io";
import { parseFixtureDocument, type ValidationIssue, validateFixtures } from "./fixture-validation";
import { CorpusGenerationError, generateCorpus } from "./generate-corpus";
import {
  type CalibrationRunDependencies,
  type CalibrationRunRequest,
  type CredentialCheck,
  createLiveCalibrationPort,
  runCalibration,
} from "./run-calibration";
import type { SyntheticCalibrationFixture } from "./types";

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
      return dispatch(parsed.command);
  }
}

async function dispatch(command: CalibrationCommand): Promise<number> {
  switch (command.kind) {
    case "generate":
      return runGenerate(command.seed, command.count, command.output);
    case "run":
      return runRun(command);
  }
}

async function runGenerate(seed: string, count: number, output: string): Promise<number> {
  try {
    const generated = generateCorpus({ seed, count });

    await writeTextFile(output, serializeFixtures(generated.fixtures));

    console.log(`Generated ${generated.counts.total} synthetic fixtures at ${output}`);
    console.log(
      `Provenance synthetic-author; not ground truth. Corpus hash ${generated.corpusHash}.`,
    );
    console.log(
      `Quadrants: no/no ${generated.counts.noViolationNoViolation}, yes/no ${generated.counts.violationNoViolation}, no/yes ${generated.counts.noViolationViolation}, yes/yes ${generated.counts.violationViolation}`,
    );
    console.log(
      `Difficulty: clear ${generated.counts.clear}, borderline ${generated.counts.borderline}`,
    );

    return 0;
  } catch (error) {
    const message = error instanceof CorpusGenerationError ? error.message : "generation failed";

    console.error(`error: ${message}`);

    return 1;
  }
}

export type ValidationCode =
  | "STRUCTURAL_VALIDATION_FAILED"
  | "DUPLICATE_FIXTURE_ID"
  | "EMPTY_TASK"
  | "FIXTURE_HAS_NO_FILES"
  | "EMPTY_PATCH"
  | "PATCH_WITHOUT_CHANGES"
  | "UNSUPPORTED_PATH"
  | "SECRET_LIKE_MARKER"
  | "EVIDENCE_UNAVAILABLE"
  | "MISSING_CATEGORY"
  | "QUADRANT_TOTAL_MISMATCH"
  | "BORDERLINE_SHARE_MISMATCH"
  | "QUADRANT_UNREPRESENTED"
  | "BORDERLINE_ABSENT"
  | "VALIDATION_FAILED";

export type CorpusLoadResult =
  | { readonly status: "READY"; readonly fixtures: readonly SyntheticCalibrationFixture[] }
  | { readonly status: "INVALID"; readonly codes: readonly ValidationCode[] };

const STRUCTURAL_VALIDATION_CODE: ValidationCode = "STRUCTURAL_VALIDATION_FAILED";

const MESSAGE_CODE_PREFIXES: readonly (readonly [string, ValidationCode])[] = [
  ["duplicate fixture id", "DUPLICATE_FIXTURE_ID"],
  ["empty task", "EMPTY_TASK"],
  ["fixture has no files", "FIXTURE_HAS_NO_FILES"],
  ["empty patch for ", "EMPTY_PATCH"],
  ["patch without changes for ", "PATCH_WITHOUT_CHANGES"],
  ["unsupported path ", "UNSUPPORTED_PATH"],
  ["fixture contains a secret-like marker", "SECRET_LIKE_MARKER"],
  ["evidence not selectable (", "EVIDENCE_UNAVAILABLE"],
  ["missing category ", "MISSING_CATEGORY"],
  ["quadrants must each total ", "QUADRANT_TOTAL_MISMATCH"],
  ["borderline corpus share must be 25%", "BORDERLINE_SHARE_MISMATCH"],
  ["every quadrant must be represented", "QUADRANT_UNREPRESENTED"],
  ["borderline cases must be present", "BORDERLINE_ABSENT"],
];

/**
 * Maps a validation issue to a fixed code by its message prefix. Only structural
 * knowledge of the message vocabulary is used: any fixture-supplied task, patch,
 * path, or id text is discarded and never returned to the caller.
 */
function validationCodeForIssue(issue: ValidationIssue): ValidationCode {
  for (const [prefix, code] of MESSAGE_CODE_PREFIXES) {
    if (issue.message.startsWith(prefix)) {
      return code;
    }
  }

  return "VALIDATION_FAILED";
}

/**
 * Parses a fixture document and applies the full corpus validation used before
 * generation. Invalid input yields only fixed, allowlisted codes: never fixture
 * task, patch, path, id, or the raw parse reason.
 */
export function loadCorpus(text: string): CorpusLoadResult {
  const parsed = parseFixtureDocument(text);

  if (parsed.status === "INVALID") {
    return { status: "INVALID", codes: [STRUCTURAL_VALIDATION_CODE] };
  }

  const report = validateFixtures(parsed.fixtures);

  if (!report.valid) {
    const codes = [...new Set(report.issues.map(validationCodeForIssue))];

    return { status: "INVALID", codes };
  }

  return { status: "READY", fixtures: parsed.fixtures };
}

export interface CorpusRunDependencies {
  readonly readFile: (path: string) => Promise<string>;
  readonly error: (line: string) => void;
  readonly execute: (
    command: RunCommand,
    fixtures: readonly SyntheticCalibrationFixture[],
  ) => Promise<number>;
}

/**
 * Validates a run's fixture document before the credential- or API-bearing
 * executor is invoked. An invalid corpus performs zero executor work and prints
 * only safe validation codes.
 */
export async function runCorpusCommand(
  command: RunCommand,
  dependencies: CorpusRunDependencies,
): Promise<number> {
  let text: string;

  try {
    text = await dependencies.readFile(command.input);
  } catch {
    dependencies.error(`error: cannot read fixtures at ${command.input}`);

    return 1;
  }

  const loaded = loadCorpus(text);

  if (loaded.status === "INVALID") {
    dependencies.error(
      "error: fixture corpus failed validation; no credential or API call was made.",
    );

    for (const code of loaded.codes) {
      dependencies.error(`  - ${code}`);
    }

    return 1;
  }

  return dependencies.execute(command, loaded.fixtures);
}

async function runRun(command: RunCommand): Promise<number> {
  return runCorpusCommand(command, {
    readFile: readTextFile,
    error: (line) => console.error(line),
    execute: executeRun,
  });
}

async function executeRun(
  command: RunCommand,
  fixtures: readonly SyntheticCalibrationFixture[],
): Promise<number> {
  const now = new Date();
  const runId = formatRunId(now);
  const request: CalibrationRunRequest = {
    fixtures,
    limit: command.limit,
    concurrency: command.concurrency,
    repeat: command.repeat,
    difficulty: command.difficulty,
    categories: command.categories,
    confirmLiveApi: command.confirmLiveApi,
    seed: CALIBRATION_SEED,
    requestedModel: JEV_MODEL,
    outputDir: runDirectory(runId),
  };
  const credentials = createCredentialProvider({
    environment: createProcessEnvironment(),
    store: createKeyringCredentialStore(),
  });
  const dependencies: CalibrationRunDependencies = {
    createPort: (concurrency, observer) => createLiveCalibrationPort(concurrency, observer),
    checkCredential: async (): Promise<CredentialCheck> => {
      try {
        const resolution = await credentials.resolve();

        return resolution.status === "AVAILABLE" ? "AVAILABLE" : resolution.reason;
      } catch {
        return "STORE_READ_FAILURE";
      }
    },
    now: () => now,
    runId,
    writeFile: writeTextFile,
    log: (line) => console.log(line),
  };

  console.log(`Corpus hash ${hashFixtures(fixtures)}`);

  const result = await runCalibration(request, dependencies);

  if (result.reportPaths !== null) {
    console.log(`Report written: ${result.reportPaths.json}`);
    console.log(`Report written: ${result.reportPaths.markdown}`);
  }

  return result.exitCode;
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

  return `run-${parts.slice(0, 3).join("")}-${parts.slice(3).join("")}`;
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
