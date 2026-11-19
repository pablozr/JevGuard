import type { PricingInput } from "./types";

export const DEFAULT_CORPUS_DIRECTORY = "benchmarks/corpus";
export const DEFAULT_OUTPUT_DIRECTORY = "benchmarks/results";
export const DEFAULT_REPEAT = 1;
export const MAX_REPEAT = 5;
export const DEFAULT_HOST_CASES = 2;
export const MAX_HOST_CASES = 20;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 200;
export const DEFAULT_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 2;

export const HOST_IDS = ["opencode", "claude-code"] as const;
export type HostId = (typeof HOST_IDS)[number];

/**
 * Jev list price published by TypeSafe: $0.042 per million input tokens and no
 * charge for output tokens. The price is not carried by the API response, so it is
 * recorded as a run input and the report names where it came from.
 */
export const LIST_PRICE: PricingInput = {
  inputUsdPerMillionTokens: 0.042,
  outputUsdPerMillionTokens: 0,
  source: "docs.typesafe.ai/models, read 2026-11-19: $42 per billion input tokens, output free",
};

export interface RunCommand {
  readonly kind: "run";
  readonly corpusDirectory: string;
  readonly outputDirectory: string;
  readonly ruleIds: readonly string[];
  readonly limit: number;
  readonly repeat: number;
  readonly hosts: readonly HostId[];
  readonly hostCases: number;
  readonly concurrency: number;
  readonly confirmLiveRuns: string | null;
  readonly pricing: PricingInput;
}

export type BenchmarkCommand = RunCommand;

export type ParseResult =
  | { readonly status: "OK"; readonly command: BenchmarkCommand }
  | { readonly status: "HELP"; readonly text: string }
  | { readonly status: "ERROR"; readonly message: string };

const OPTIONS: readonly string[] = [
  "--corpus",
  "--output",
  "--rule",
  "--limit",
  "--repeat",
  "--hosts",
  "--host-cases",
  "--concurrency",
  "--confirm-live-runs",
  "--price-input",
  "--price-output",
];

const HELP_TEXT = [
  "JevGuard public benchmark harness (author-labeled synthetic corpus).",
  "",
  "Usage:",
  "  benchmark run [--corpus <dir>] [--output <dir>] [--rule <id>]... [--limit <n>]",
  "                [--repeat <n>] [--hosts <opencode,claude-code|none>]",
  "                [--host-cases <n>] [--concurrency <n>]",
  "                [--price-input <usd-per-mtok>] [--price-output <usd-per-mtok>]",
  "                [--confirm-live-runs <review-count>]",
  "",
  "The accuracy pass runs one Jev rule evaluation per selected case (one call each).",
  "Each host probe runs a complete review of one case through that host's review entry",
  "(one call per repository rule plus one built-in batch).",
  "",
  "A run performs zero API calls unless --confirm-live-runs equals the planned number",
  "of reviews exactly.",
].join("\n");

export function parseArguments(argv: readonly string[]): ParseResult {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { status: "HELP", text: HELP_TEXT };
  }

  const [command, ...rest] = argv;

  if (command !== "run") {
    return { status: "ERROR", message: `unknown command: ${command ?? ""}` };
  }

  return parseRun(rest);
}

function parseRun(tokens: readonly string[]): ParseResult {
  const collected = collectOptions(tokens);

  if (!collected.ok) {
    return { status: "ERROR", message: collected.message };
  }

  const repeat = readInteger(collected.options, "--repeat", DEFAULT_REPEAT, 1, MAX_REPEAT);

  if (typeof repeat === "string") {
    return { status: "ERROR", message: repeat };
  }

  const limit = readInteger(collected.options, "--limit", MAX_LIMIT, MIN_LIMIT, MAX_LIMIT);

  if (typeof limit === "string") {
    return { status: "ERROR", message: limit };
  }

  const hostCases = readInteger(
    collected.options,
    "--host-cases",
    DEFAULT_HOST_CASES,
    1,
    MAX_HOST_CASES,
  );

  if (typeof hostCases === "string") {
    return { status: "ERROR", message: hostCases };
  }

  const concurrency = readInteger(
    collected.options,
    "--concurrency",
    DEFAULT_CONCURRENCY,
    1,
    MAX_CONCURRENCY,
  );

  if (typeof concurrency === "string") {
    return { status: "ERROR", message: concurrency };
  }

  const hosts = readHosts(collected.options.get("--hosts") ?? []);

  if (typeof hosts === "string") {
    return { status: "ERROR", message: hosts };
  }

  const pricing = readPricing(collected.options);

  if (typeof pricing === "string") {
    return { status: "ERROR", message: pricing };
  }

  return {
    status: "OK",
    command: {
      kind: "run",
      corpusDirectory: readSingle(collected.options, "--corpus") ?? DEFAULT_CORPUS_DIRECTORY,
      outputDirectory: readSingle(collected.options, "--output") ?? DEFAULT_OUTPUT_DIRECTORY,
      ruleIds: collected.options.get("--rule") ?? [],
      limit,
      repeat,
      hosts,
      hostCases,
      concurrency,
      confirmLiveRuns: readSingle(collected.options, "--confirm-live-runs") ?? null,
      pricing,
    },
  };
}

type OptionMap = ReadonlyMap<string, readonly string[]>;

type CollectResult =
  | { readonly ok: true; readonly options: OptionMap }
  | { readonly ok: false; readonly message: string };

function collectOptions(tokens: readonly string[]): CollectResult {
  const options = new Map<string, string[]>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";

    if (!OPTIONS.includes(token)) {
      return { ok: false, message: `unknown option: ${token}` };
    }

    const value = tokens[index + 1];

    if (value === undefined) {
      return { ok: false, message: `${token} needs a value` };
    }

    const values = options.get(token) ?? [];
    values.push(value);
    options.set(token, values);
    index += 1;
  }

  return { ok: true, options };
}

function readSingle(options: OptionMap, name: string): string | undefined {
  const values = options.get(name);

  if (values === undefined) {
    return undefined;
  }

  return values[0];
}

function readInteger(
  options: OptionMap,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | string {
  const text = readSingle(options, name);

  if (text === undefined) {
    return fallback;
  }

  const value = Number(text);

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    return `${name} must be an integer between ${minimum} and ${maximum}`;
  }

  return value;
}

function readHosts(values: readonly string[]): readonly HostId[] | string {
  if (values.length === 0) {
    return [...HOST_IDS];
  }

  const requested = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");

  if (requested.length === 1 && requested[0] === "none") {
    return [];
  }

  const unknown = requested.filter((value) => !HOST_IDS.includes(value as HostId));

  if (unknown.length > 0) {
    return `unknown host: ${unknown.join(", ")}; expected ${HOST_IDS.join(", ")} or none`;
  }

  return [...new Set(requested)] as HostId[];
}

function readPricing(options: OptionMap): PricingInput | string {
  const input = readPrice(options, "--price-input", LIST_PRICE.inputUsdPerMillionTokens);
  const output = readPrice(options, "--price-output", LIST_PRICE.outputUsdPerMillionTokens);

  if (typeof input === "string") return input;
  if (typeof output === "string") return output;

  return {
    inputUsdPerMillionTokens: input,
    outputUsdPerMillionTokens: output,
    source: LIST_PRICE.source,
  };
}

function readPrice(options: OptionMap, name: string, fallback: number): number | string {
  const text = readSingle(options, name);

  if (text === undefined) {
    return fallback;
  }

  const value = Number(text);

  if (!Number.isFinite(value) || value < 0) {
    return `${name} must be a nonnegative number`;
  }

  return value;
}
