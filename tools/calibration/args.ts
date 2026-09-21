import { CALIBRATION_SEED, DEFAULT_FIXTURE_COUNT, MAX_FIXTURE_COUNT } from "./fixture-catalog";
import { DEFAULT_FIXTURES_PATH } from "./fixture-io";
import {
  CALIBRATION_CATEGORIES,
  type CalibrationCategory,
  type CalibrationDifficulty,
} from "./types";

export const MAX_PLANNED_CALLS = 500;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 200;
export const DEFAULT_CONCURRENCY = 2;
export const MAX_CONCURRENCY = 4;
export const MAX_REPEAT = 5;

export interface GenerateCommand {
  readonly kind: "generate";
  readonly seed: string;
  readonly count: number;
  readonly output: string;
}

export interface RunCommand {
  readonly kind: "run";
  readonly input: string;
  readonly limit: number;
  readonly concurrency: number;
  readonly repeat: number;
  readonly difficulty: CalibrationDifficulty | null;
  readonly categories: readonly CalibrationCategory[];
  readonly confirmLiveApi: string | null;
}

export type CalibrationCommand = GenerateCommand | RunCommand;

export type CliParseResult =
  | { readonly status: "OK"; readonly command: CalibrationCommand }
  | { readonly status: "HELP"; readonly text: string }
  | { readonly status: "ERROR"; readonly message: string };

const GENERATE_OPTIONS: readonly string[] = ["--seed", "--count", "--output"];
const RUN_OPTIONS: readonly string[] = [
  "--input",
  "--limit",
  "--concurrency",
  "--repeat",
  "--difficulty",
  "--category",
  "--confirm-live-api",
];

const HELP_TEXT = [
  "JevGuard calibration harness (local, synthetic author labels).",
  "",
  "Usage:",
  "  calibration generate [--seed <string>] [--count <number>] [--output <path>]",
  "  calibration run --limit <number> [--input <path>] [--concurrency <n>] [--repeat <n>]",
  "                 [--difficulty clear|borderline] [--category <value>]...",
  "                 [--confirm-live-api <logical-call-count>]",
  "",
  "A run performs zero API calls unless --confirm-live-api equals the planned",
  "number of logical evaluations exactly.",
].join("\n");

export function parseArguments(argv: readonly string[]): CliParseResult {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { status: "HELP", text: HELP_TEXT };
  }

  const [command, ...rest] = argv;

  switch (command) {
    case "generate":
      return parseGenerate(rest);
    case "run":
      return parseRun(rest);
    default:
      return { status: "ERROR", message: `unknown command: ${command ?? ""}` };
  }
}

function parseGenerate(tokens: readonly string[]): CliParseResult {
  const collected = collectOptions(tokens, GENERATE_OPTIONS);

  if (!collected.ok) {
    return { status: "ERROR", message: collected.message };
  }

  const seed = readSingle(collected.options, "--seed") ?? CALIBRATION_SEED;
  const countText = readSingle(collected.options, "--count");
  const count = countText === undefined ? DEFAULT_FIXTURE_COUNT : Number(countText);

  if (!Number.isInteger(count) || count < 1 || count > MAX_FIXTURE_COUNT) {
    return {
      status: "ERROR",
      message: `--count must be an integer between 1 and ${MAX_FIXTURE_COUNT}`,
    };
  }

  const output = readSingle(collected.options, "--output") ?? DEFAULT_FIXTURES_PATH;

  return { status: "OK", command: { kind: "generate", seed, count, output } };
}

function parseRun(tokens: readonly string[]): CliParseResult {
  const collected = collectOptions(tokens, RUN_OPTIONS);

  if (!collected.ok) {
    return { status: "ERROR", message: collected.message };
  }

  const limitText = readSingle(collected.options, "--limit");

  if (limitText === undefined) {
    return { status: "ERROR", message: "--limit is required" };
  }

  const limit = Number(limitText);

  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    return {
      status: "ERROR",
      message: `--limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`,
    };
  }

  const concurrency = readNumber(collected.options, "--concurrency", DEFAULT_CONCURRENCY);

  if (concurrency === null || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    return {
      status: "ERROR",
      message: `--concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`,
    };
  }

  const repeat = readNumber(collected.options, "--repeat", 1);

  if (repeat === null || repeat < 1 || repeat > MAX_REPEAT) {
    return { status: "ERROR", message: `--repeat must be an integer between 1 and ${MAX_REPEAT}` };
  }

  const difficulty = parseDifficulty(readSingle(collected.options, "--difficulty"));

  if (difficulty === "INVALID") {
    return { status: "ERROR", message: "--difficulty must be clear or borderline" };
  }

  const categories = parseCategories(collected.options.get("--category") ?? []);

  if (categories === "INVALID") {
    return {
      status: "ERROR",
      message: `--category must be one of: ${CALIBRATION_CATEGORIES.join(", ")}`,
    };
  }

  const confirmLiveApi = readSingle(collected.options, "--confirm-live-api") ?? null;

  return {
    status: "OK",
    command: {
      kind: "run",
      input: readSingle(collected.options, "--input") ?? DEFAULT_FIXTURES_PATH,
      limit,
      concurrency,
      repeat,
      difficulty,
      categories,
      confirmLiveApi,
    },
  };
}

function parseDifficulty(value: string | undefined): CalibrationDifficulty | null | "INVALID" {
  if (value === undefined) {
    return null;
  }

  return value === "clear" || value === "borderline" ? value : "INVALID";
}

function parseCategories(values: readonly string[]): readonly CalibrationCategory[] | "INVALID" {
  const categories: CalibrationCategory[] = [];

  for (const value of values) {
    const match = CALIBRATION_CATEGORIES.find((category) => category === value);

    if (match === undefined) {
      return "INVALID";
    }

    categories.push(match);
  }

  return categories;
}

function readSingle(
  options: ReadonlyMap<string, readonly string[]>,
  key: string,
): string | undefined {
  const values = options.get(key);

  return values === undefined ? undefined : values[values.length - 1];
}

function readNumber(
  options: ReadonlyMap<string, readonly string[]>,
  key: string,
  fallback: number,
): number | null {
  const text = readSingle(options, key);

  if (text === undefined) {
    return fallback;
  }

  const value = Number(text);

  return Number.isInteger(value) ? value : null;
}

type CollectResult =
  | { readonly ok: true; readonly options: ReadonlyMap<string, readonly string[]> }
  | { readonly ok: false; readonly message: string };

function collectOptions(tokens: readonly string[], allowed: readonly string[]): CollectResult {
  const options = new Map<string, string[]>();

  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (token === undefined) {
      break;
    }

    const equalsIndex = token.indexOf("=");
    const key = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);

    if (!key.startsWith("--")) {
      return { ok: false, message: `unexpected argument: ${token}` };
    }

    if (!allowed.some((option) => option === key)) {
      return { ok: false, message: `unknown option: ${key}` };
    }

    let value = inlineValue;

    if (value === undefined) {
      const next = tokens[index + 1];

      if (next === undefined || next.startsWith("--")) {
        return { ok: false, message: `missing value for ${key}` };
      }

      value = next;
      index += 1;
    }

    const existing = options.get(key);

    if (existing === undefined) {
      options.set(key, [value]);
    } else {
      existing.push(value);
    }

    index += 1;
  }

  return { ok: true, options };
}
