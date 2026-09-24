import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseRules, resolveGateConfig, resolveRemediationConfig } from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/opencode-adapter/policy";
import type {
  InitValidationCode,
  InitValidatorErrorCode,
  InitValidatorReport,
  ProvenanceRule,
} from "../types";
import { parseProvenance } from "./provenance";

const MAX_DOCUMENT_BYTES = 1_048_576;
const EXIT_VALID = 0;
const EXIT_INVALID = 1;
const EXIT_ERROR = 2;
const EXPECTED_ARGUMENT_COUNT = 2;

type DocumentRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: InitValidatorErrorCode };

function print(report: InitValidatorReport, exitCode: number): number {
  process.stdout.write(`${JSON.stringify(report)}\n`);

  return exitCode;
}

function fail(errorCode: InitValidatorErrorCode): number {
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
    const stats = lstatSync(path);

    if (stats.isSymbolicLink()) {
      return { ok: false, code: "SYMLINK_PATH" };
    }

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

/**
 * Validates one confirmed `jev-init` candidate pair with the production rule parser,
 * provenance rules, and the production gate/remediation config resolvers. The report
 * carries only rule IDs and deterministic codes; it never includes rule text, evidence
 * contents, or config values.
 */
function validate(rulesText: string, configText: string): InitValidatorReport {
  const codes = new Set<InitValidationCode>();
  const parsedRules: ProvenanceRule[] = [];

  for (const result of parseRules(rulesText)) {
    if (result.status === "PARSED") {
      parsedRules.push({ id: result.rule.id, severity: result.rule.severity });
      continue;
    }

    codes.add(result.code);
  }

  const provenance = parseProvenance(rulesText, parsedRules);

  if (provenance.status === "invalid") {
    for (const code of provenance.codes) {
      codes.add(code);
    }
  }

  readConfigCodes(configText, codes);

  const sortedCodes = [...codes].sort();

  return {
    status: sortedCodes.length === 0 ? "valid" : "invalid",
    ruleIds: parsedRules.map((rule) => rule.id),
    codes: sortedCodes,
  };
}

function readConfigCodes(text: string, codes: Set<InitValidationCode>): void {
  const parsed = parsePolicyConfig(text);

  if (parsed.status !== "PARSED") {
    codes.add("CONFIG_PARSE_INVALID");
    return;
  }

  if (resolveGateConfig(parsed.value).status === "INVALID") {
    codes.add("CONFIG_INVALID");
  }

  if (resolveRemediationConfig(parsed.value).status === "INVALID") {
    codes.add("REMEDIATION_INVALID");
  }
}

function main(argv: readonly string[]): number {
  if (argv.length !== EXPECTED_ARGUMENT_COUNT) {
    return fail("EXPECTED_TWO_PATH_ARGUMENTS");
  }

  const rulesPath = resolvePath(argv[0] ?? "");
  const configPath = resolvePath(argv[1] ?? "");

  if (rulesPath === null || configPath === null) {
    return fail("INVALID_PATH");
  }

  const rules = readDocument(rulesPath);

  if (!rules.ok) {
    return fail(rules.code);
  }

  const config = readDocument(configPath);

  if (!config.ok) {
    return fail(config.code);
  }

  const report = validate(rules.text, config.text);

  return print(report, report.status === "valid" ? EXIT_VALID : EXIT_INVALID);
}

process.exitCode = main(process.argv.slice(2));
