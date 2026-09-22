import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { RuleValidatorErrorCode, RuleValidatorReport } from "../types";
import { summarizeRules } from "./rules-summary";

const MAX_DOCUMENT_BYTES = 1_048_576;
const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_ERROR = 2;
const EXPECTED_ARGUMENT_COUNT = 1;

type DocumentRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: RuleValidatorErrorCode };

function print(report: RuleValidatorReport, exitCode: number): number {
  process.stdout.write(`${JSON.stringify(report)}\n`);

  return exitCode;
}

function fail(errorCode: RuleValidatorErrorCode): number {
  return print({ status: "error", errorCode }, EXIT_ERROR);
}

function resolvePath(requested: string): string | null {
  try {
    return resolve(requested);
  } catch {
    return null;
  }
}

function readDocument(path: string): DocumentRead {
  let size: number;

  try {
    const stats = statSync(path);

    if (!stats.isFile()) {
      return { ok: false, code: "NOT_A_FILE" };
    }

    size = stats.size;
  } catch {
    return { ok: false, code: "NOT_A_FILE" };
  }

  if (size > MAX_DOCUMENT_BYTES) {
    return { ok: false, code: "FILE_TOO_LARGE" };
  }

  try {
    return { ok: true, text: readFileSync(path, "utf8") };
  } catch {
    return { ok: false, code: "READ_FAILURE" };
  }
}

function main(argv: readonly string[]): number {
  if (argv.length !== EXPECTED_ARGUMENT_COUNT) {
    return fail("EXPECTED_ONE_PATH_ARGUMENT");
  }

  const requested = argv[0];

  if (requested === undefined || requested.length === 0) {
    return fail("EXPECTED_ONE_PATH_ARGUMENT");
  }

  const path = resolvePath(requested);

  if (path === null) {
    return fail("INVALID_PATH");
  }

  const document = readDocument(path);

  if (!document.ok) {
    return fail(document.code);
  }

  const summary = summarizeRules(document.text);

  return print(summary, summary.status === "valid" ? EXIT_VALID : EXIT_INVALID);
}

process.exitCode = main(process.argv.slice(2));
