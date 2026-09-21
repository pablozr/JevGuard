import { DEFAULT_EVIDENCE_POLICY, checkFilePath, selectTurnEvidence } from "@jevguard/core";
import type { TurnFile } from "@jevguard/core";
import {
  CALIBRATION_CATEGORIES,
  type CalibrationCategory,
  type CalibrationDifficulty,
  type CalibrationLabel,
  type SyntheticCalibrationFixture,
} from "./types";

export type FixtureParseResult =
  | { readonly status: "PARSED"; readonly fixtures: readonly SyntheticCalibrationFixture[] }
  | { readonly status: "INVALID"; readonly reason: string };

export interface ValidationIssue {
  readonly fixtureId: string;
  readonly message: string;
}

export interface CorpusCounts {
  total: number;
  noViolationNoViolation: number;
  violationNoViolation: number;
  noViolationViolation: number;
  violationViolation: number;
  clear: number;
  borderline: number;
}

export interface ValidationReport {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
  readonly counts: CorpusCounts;
}

const DEFAULT_CORPUS_COUNT = 160;
const DEFAULT_QUADRANT_COUNT = 40;
const DEFAULT_BORDERLINE_COUNT = 40;

const VALID_LABELS: readonly CalibrationLabel[] = ["VIOLATION", "NO_VIOLATION"];
const VALID_DIFFICULTIES: readonly CalibrationDifficulty[] = ["clear", "borderline"];
const SECRET_MARKERS = ["BEGIN RSA PRIVATE KEY", "BEGIN OPENSSH PRIVATE KEY", "AKIA", "sk-live"];

/**
 * Parses JSONL fixture text as `unknown` and validates each record structurally. A
 * malformed line, unknown field shape, or empty document is `INVALID`; no assertion
 * is used to coerce the parsed value.
 */
export function parseFixtureDocument(text: string): FixtureParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  if (lines.length === 0) {
    return { status: "INVALID", reason: "fixture document is empty" };
  }

  const fixtures: SyntheticCalibrationFixture[] = [];

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      return { status: "INVALID", reason: `line ${index + 1} is not valid JSON` };
    }

    if (!isFixture(parsed)) {
      return { status: "INVALID", reason: `line ${index + 1} is not a valid fixture` };
    }

    fixtures.push(parsed);
  }

  return { status: "PARSED", fixtures };
}

export function isFixture(value: unknown): value is SyntheticCalibrationFixture {
  if (!isRecord(value)) {
    return false;
  }

  if (value.schemaVersion !== 1 || value.provenance !== "synthetic-author") {
    return false;
  }

  if (typeof value.id !== "string" || value.id === "") {
    return false;
  }

  if (typeof value.task !== "string" || value.task.trim() === "") {
    return false;
  }

  if (!isCategory(value.category) || !isDifficulty(value.difficulty)) {
    return false;
  }

  if (!isTurnFiles(value.files)) {
    return false;
  }

  return isExpected(value.expected);
}

function isTurnFiles(value: unknown): value is readonly TurnFile[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => isRecord(item) && typeof item.path === "string" && typeof item.patch === "string",
    )
  );
}

function isExpected(value: unknown): value is SyntheticCalibrationFixture["expected"] {
  return isRecord(value) && isLabel(value.scopeCreep) && isLabel(value.complexity);
}

function isLabel(value: unknown): value is CalibrationLabel {
  return typeof value === "string" && VALID_LABELS.some((label) => label === value);
}

function isDifficulty(value: unknown): value is CalibrationDifficulty {
  return typeof value === "string" && VALID_DIFFICULTIES.some((item) => item === value);
}

function isCategory(value: unknown): value is CalibrationCategory {
  return typeof value === "string" && CALIBRATION_CATEGORIES.some((category) => category === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates generated fixtures before they are written: identity, nonempty content,
 * safe paths, complete selectable evidence, changed patches, category coverage, and
 * label balance for the default corpus.
 */
export function validateFixtures(
  fixtures: readonly SyntheticCalibrationFixture[],
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  const seenCategories = new Set<CalibrationCategory>();
  const counts = {
    total: fixtures.length,
    noViolationNoViolation: 0,
    violationNoViolation: 0,
    noViolationViolation: 0,
    violationViolation: 0,
    clear: 0,
    borderline: 0,
  };

  for (const fixture of fixtures) {
    if (seenIds.has(fixture.id)) {
      issues.push({ fixtureId: fixture.id, message: "duplicate fixture id" });
    }

    seenIds.add(fixture.id);
    seenCategories.add(fixture.category);
    countQuadrant(counts, fixture);
    countDifficulty(counts, fixture);

    if (fixture.task.trim() === "") {
      issues.push({ fixtureId: fixture.id, message: "empty task" });
    }

    validateFiles(fixture, issues);
    validateNoSecrets(fixture, issues);
    validateEvidence(fixture, issues);
  }

  if (fixtures.length === DEFAULT_CORPUS_COUNT) {
    for (const category of CALIBRATION_CATEGORIES) {
      if (!seenCategories.has(category)) {
        issues.push({ fixtureId: "<corpus>", message: `missing category ${category}` });
      }
    }

    for (const count of [
      counts.noViolationNoViolation,
      counts.violationNoViolation,
      counts.noViolationViolation,
      counts.violationViolation,
    ]) {
      if (count !== DEFAULT_QUADRANT_COUNT) {
        issues.push({
          fixtureId: "<corpus>",
          message: `quadrants must each total ${DEFAULT_QUADRANT_COUNT}`,
        });
        break;
      }
    }

    if (counts.borderline !== DEFAULT_BORDERLINE_COUNT) {
      issues.push({ fixtureId: "<corpus>", message: "borderline corpus share must be 25%" });
    }
  } else if (fixtures.length >= 4) {
    const quadrants = [
      counts.noViolationNoViolation,
      counts.violationNoViolation,
      counts.noViolationViolation,
      counts.violationViolation,
    ];

    if (quadrants.some((count) => count === 0)) {
      issues.push({ fixtureId: "<corpus>", message: "every quadrant must be represented" });
    }

    if (fixtures.length >= 8 && counts.borderline === 0) {
      issues.push({ fixtureId: "<corpus>", message: "borderline cases must be present" });
    }
  }

  return { valid: issues.length === 0, issues, counts };
}

function countQuadrant(counts: CorpusCounts, fixture: SyntheticCalibrationFixture): void {
  const scope = fixture.expected.scopeCreep;
  const complexity = fixture.expected.complexity;

  if (scope === "NO_VIOLATION" && complexity === "NO_VIOLATION") {
    counts.noViolationNoViolation += 1;
  } else if (scope === "VIOLATION" && complexity === "NO_VIOLATION") {
    counts.violationNoViolation += 1;
  } else if (scope === "NO_VIOLATION" && complexity === "VIOLATION") {
    counts.noViolationViolation += 1;
  } else {
    counts.violationViolation += 1;
  }
}

function countDifficulty(counts: CorpusCounts, fixture: SyntheticCalibrationFixture): void {
  if (fixture.difficulty === "clear") {
    counts.clear += 1;
  } else {
    counts.borderline += 1;
  }
}

function validateFiles(fixture: SyntheticCalibrationFixture, issues: ValidationIssue[]): void {
  if (fixture.files.length === 0) {
    issues.push({ fixtureId: fixture.id, message: "fixture has no files" });
    return;
  }

  for (const file of fixture.files) {
    if (file.patch.trim() === "") {
      issues.push({ fixtureId: fixture.id, message: `empty patch for ${file.path}` });
    }

    if (!hasChangedLine(file.patch)) {
      issues.push({ fixtureId: fixture.id, message: `patch without changes for ${file.path}` });
    }

    if (!checkFilePath(file.path, DEFAULT_EVIDENCE_POLICY).allowed) {
      issues.push({ fixtureId: fixture.id, message: `unsupported path ${file.path}` });
    }
  }
}

function hasChangedLine(patch: string): boolean {
  return patch
    .split("\n")
    .some(
      (line) =>
        (line.startsWith("+") || line.startsWith("-")) &&
        !line.startsWith("+++") &&
        !line.startsWith("---"),
    );
}

function validateNoSecrets(fixture: SyntheticCalibrationFixture, issues: ValidationIssue[]): void {
  const text = [fixture.task, ...fixture.files.map((file) => `${file.path}\n${file.patch}`)].join(
    "\n",
  );

  if (SECRET_MARKERS.some((marker) => text.includes(marker))) {
    issues.push({ fixtureId: fixture.id, message: "fixture contains a secret-like marker" });
  }
}

function validateEvidence(fixture: SyntheticCalibrationFixture, issues: ValidationIssue[]): void {
  const selection = selectTurnEvidence(
    { id: fixture.id, task: fixture.task, files: fixture.files },
    DEFAULT_EVIDENCE_POLICY,
  );

  if (selection.status !== "SELECTED") {
    issues.push({
      fixtureId: fixture.id,
      message: `evidence not selectable (${selection.status})`,
    });
  }
}
