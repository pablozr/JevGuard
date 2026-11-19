import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRules, parseUnifiedDiff } from "@jevguard/core";
import { STARTER_RULES } from "../../packages/cli/src/setup/scaffold";
import type { BenchmarkCase, CorpusRule, ExpectedLabel, LoadedCorpus, RuleSeverity } from "./types";

/**
 * The corpus is a directory of JSON documents, one per rule of the initial pack.
 * Every diff must be a plain `git diff` the plugin itself accepts, so a case can
 * never pass validation while the host would refuse its input.
 */

export type CorpusValidationCode =
  | "CORPUS_READ_FAILED"
  | "CORPUS_PARSE_FAILED"
  | "CORPUS_SHAPE_INVALID"
  | "CORPUS_WITHOUT_CASES"
  | "RULE_MISMATCH"
  | "UNKNOWN_RULE"
  | "INVALID_STARTER_RULE"
  | "DUPLICATE_CASE_ID"
  | "EXPECTED_NOT_FEASIBLE"
  | "MISSING_CLEAN_CASE"
  | "MISSING_VIOLATION_CASE"
  | "EMPTY_DIFF"
  | "DIFF_INVALID";

export type CorpusLoadResult =
  | { readonly status: "READY"; readonly corpus: LoadedCorpus }
  | { readonly status: "INVALID"; readonly codes: readonly CorpusValidationCode[] };

interface RawCorpusCase {
  readonly id: string;
  readonly task: string;
  readonly expected: string;
  readonly rationale: string;
  readonly diff: readonly string[];
}

interface RawCorpusDocument {
  readonly version: number;
  readonly rule: string;
  readonly cases: readonly RawCorpusCase[];
}

const EXPECTED_LABELS: readonly ExpectedLabel[] = ["PASS", "WARN", "FAIL"];

const FEASIBLE_BY_SEVERITY: Readonly<Record<RuleSeverity, readonly ExpectedLabel[]>> = {
  error: ["PASS", "WARN", "FAIL"],
  warning: ["PASS", "WARN"],
};

export async function loadCorpus(directory: string): Promise<CorpusLoadResult> {
  const rules = starterRules();
  const codes = new Set<CorpusValidationCode>();
  const cases: BenchmarkCase[] = [];

  if (rules === null) {
    return { status: "INVALID", codes: ["INVALID_STARTER_RULE"] };
  }

  let files: string[];

  try {
    files = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return { status: "INVALID", codes: ["CORPUS_READ_FAILED"] };
  }

  if (files.length === 0) {
    return { status: "INVALID", codes: ["CORPUS_WITHOUT_CASES"] };
  }

  const seen = new Set<string>();

  for (const name of files) {
    const parsed = await readDocument(join(directory, name));

    if (parsed === null) {
      codes.add("CORPUS_PARSE_FAILED");
      continue;
    }

    if (parsed === undefined) {
      codes.add("CORPUS_READ_FAILED");
      continue;
    }

    const rule = rules.get(parsed.rule);

    if (rule === undefined) {
      codes.add("UNKNOWN_RULE");
      continue;
    }

    if (parsed.cases.length === 0) {
      codes.add("CORPUS_WITHOUT_CASES");
      continue;
    }

    for (const raw of parsed.cases) {
      const loaded = toCase(raw, rule.level, seen, codes);

      if (loaded !== null) {
        cases.push(loaded);
      }
    }
  }

  checkRuleCoverage(cases, codes);

  if (codes.size > 0) {
    return { status: "INVALID", codes: [...codes].sort() };
  }

  return {
    status: "READY",
    corpus: { cases, rules: [...rules.values()].map((rule) => rule.level), hash: hashCases(cases) },
  };
}

function starterRules(): Map<string, { readonly level: CorpusRule }> | null {
  const parsed = parseRules(STARTER_RULES);
  const rules = new Map<string, { readonly level: CorpusRule }>();

  for (const candidate of parsed) {
    if (candidate.status !== "PARSED") {
      return null;
    }

    rules.set(candidate.rule.id, {
      level: { id: candidate.rule.id, severity: candidate.rule.severity },
    });
  }

  return rules;
}

async function readDocument(path: string): Promise<RawCorpusDocument | null | undefined> {
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }

  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  return isRawDocument(value) ? value : null;
}

function isRawDocument(value: unknown): value is RawCorpusDocument {
  if (!isRecord(value)) return false;

  if (value.version !== 1 || typeof value.rule !== "string" || !Array.isArray(value.cases)) {
    return false;
  }

  return value.cases.every(isRawCase);
}

function isRawCase(value: unknown): value is RawCorpusCase {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.task === "string" &&
    typeof value.expected === "string" &&
    typeof value.rationale === "string" &&
    Array.isArray(value.diff) &&
    value.diff.every((line) => typeof line === "string")
  );
}

function toCase(
  raw: RawCorpusCase,
  rule: CorpusRule,
  seen: Set<string>,
  codes: Set<CorpusValidationCode>,
): BenchmarkCase | null {
  if (raw.id === "" || seen.has(raw.id)) {
    codes.add("DUPLICATE_CASE_ID");

    return null;
  }

  seen.add(raw.id);

  if (!isExpectedLabel(raw.expected)) {
    codes.add("CORPUS_SHAPE_INVALID");

    return null;
  }

  if (!FEASIBLE_BY_SEVERITY[rule.severity].includes(raw.expected)) {
    codes.add("EXPECTED_NOT_FEASIBLE");

    return null;
  }

  const diff = raw.diff.join("\n").trimEnd();

  if (diff.trim() === "") {
    codes.add("EMPTY_DIFF");

    return null;
  }

  const parsed = parseUnifiedDiff(diff);

  if (parsed.status !== "PARSED" || parsed.files.length === 0) {
    codes.add("DIFF_INVALID");

    return null;
  }

  return {
    id: raw.id,
    ruleId: rule.id,
    task: raw.task,
    diff,
    expected: raw.expected,
    rationale: raw.rationale,
  };
}

function isExpectedLabel(value: string): value is ExpectedLabel {
  return EXPECTED_LABELS.includes(value as ExpectedLabel);
}

/**
 * Every rule in the corpus needs at least one clean case and at least one case that
 * must flag, so a rule can never publish a one-sided number.
 */
function checkRuleCoverage(
  cases: readonly BenchmarkCase[],
  codes: Set<CorpusValidationCode>,
): void {
  const byRule = new Map<string, ExpectedLabel[]>();

  for (const item of cases) {
    const labels = byRule.get(item.ruleId) ?? [];
    labels.push(item.expected);
    byRule.set(item.ruleId, labels);
  }

  for (const labels of byRule.values()) {
    if (!labels.includes("PASS")) {
      codes.add("MISSING_CLEAN_CASE");
    }

    if (!labels.some((label) => label !== "PASS")) {
      codes.add("MISSING_VIOLATION_CASE");
    }
  }
}

/** Stable hash over case identity and content, so a report names the corpus it used. */
export function hashCases(cases: readonly BenchmarkCase[]): string {
  const payload = cases.map((item) => [item.id, item.ruleId, item.task, item.diff, item.expected]);
  const hash = createHash("sha256");
  hash.update(JSON.stringify(payload));

  return hash.digest("hex").slice(0, 16);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
