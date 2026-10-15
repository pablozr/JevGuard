import { join } from "node:path";
import type { ReviewLogEntry } from "../review-log";
import { resolveJevGuardDataDirectory } from "./data-directory";
import { boundJsonLinesFile, isObject, parseJsonLines } from "./jsonl-file";
import type {
  LocalReviewHistory,
  LocalReviewHistoryDependencies,
  ReviewHistoryPathContext,
  ReviewHistoryReadResult,
  ReviewHistoryRecord,
  ReviewHistoryStrictReadResult,
} from "./types";

const HISTORY_FILENAME = "reviews.jsonl";

/** Rewrite the file once it grows past this many bytes, keeping only the newest records. */
export const DEFAULT_HISTORY_MAX_BYTES = 5 * 1024 * 1024;

/** Number of newest records retained by a bounded rewrite. */
export const DEFAULT_HISTORY_MAX_RECORDS = 2000;

/**
 * Builds the local JSON Lines review history. Appends are serialized within the
 * process and fully contained: any filesystem failure resolves instead of rejecting,
 * so the review path is never disturbed. A malformed line is skipped and counted on
 * read, never thrown.
 */
export function createLocalReviewHistory(
  dependencies: LocalReviewHistoryDependencies,
): LocalReviewHistory {
  const filePath = resolveHistoryFilePath(dependencies.context);
  const maxBytes = dependencies.maxBytes ?? DEFAULT_HISTORY_MAX_BYTES;
  const maxRecords = dependencies.maxRecords ?? DEFAULT_HISTORY_MAX_RECORDS;
  let tail: Promise<void> = Promise.resolve();

  async function append(entry: ReviewLogEntry): Promise<void> {
    try {
      const record: ReviewHistoryRecord = {
        ...entry,
        timestamp: dependencies.now().toISOString(),
      };

      await dependencies.fileSystem.ensureParentDirectory(filePath);
      await dependencies.fileSystem.appendFile(filePath, `${JSON.stringify(record)}\n`);
      await boundJsonLinesFile(dependencies.fileSystem, filePath, maxBytes, maxRecords);
    } catch {
      return;
    }
  }

  async function read(): Promise<ReviewHistoryReadResult> {
    const result = await readStrict();

    return result.status === "READ"
      ? { records: result.records, skippedLineCount: result.skippedLineCount }
      : { records: [], skippedLineCount: 0 };
  }

  async function readStrict(): Promise<ReviewHistoryStrictReadResult> {
    try {
      const contents = await dependencies.fileSystem.readFile(filePath);

      return { status: "READ", ...parseJsonLines(contents ?? "", parseRecord) };
    } catch {
      return { status: "FAILED" };
    }
  }

  return {
    append: (entry) => {
      const run = tail.then(() => append(entry));

      tail = run.then(ignore, ignore);

      return run;
    },
    read,
    readStrict,
  };
}

/** Resolves `jevguard/reviews.jsonl` under the configured data home. */
export function resolveHistoryFilePath(context: ReviewHistoryPathContext): string {
  return join(resolveJevGuardDataDirectory(context), HISTORY_FILENAME);
}

function parseRecord(line: string): ReviewHistoryRecord | null {
  try {
    const value: unknown = JSON.parse(line);

    return isReviewHistoryRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isReviewHistoryRecord(value: unknown): value is ReviewHistoryRecord {
  if (!isObject(value)) {
    return false;
  }

  if (typeof value.timestamp !== "string" || typeof value.turnId !== "string") {
    return false;
  }

  if (!isObject(value.summary) || !Array.isArray(value.results)) {
    return false;
  }

  return value.results.every(isHistoryResult);
}

function isHistoryResult(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }

  if (value.kind !== "RULE" && value.kind !== "BUILT_IN" && value.kind !== "REVIEW") {
    return false;
  }

  if (!isReviewOutcome(value.outcome)) {
    return false;
  }

  if (value.outcome === "UNAVAILABLE" || value.outcome === "SKIPPED") {
    return typeof value.reason === "string" && hasValidEvidence(value);
  }

  if (typeof value.violationProbability !== "number") {
    return false;
  }

  if (value.kind === "BUILT_IN") {
    return typeof value.checkId === "string" && hasValidEvidence(value);
  }

  if (value.kind === "RULE") {
    return (value.ruleId === null || typeof value.ruleId === "string") && hasValidEvidence(value);
  }

  return true;
}

function hasValidEvidence(value: Record<string, unknown>): boolean {
  const evidence = value.evidence;

  if (evidence === undefined) {
    return true;
  }

  if (!isObject(evidence)) {
    return false;
  }

  if (evidence.mode !== "WHOLE" && evidence.mode !== "SLICED") {
    return false;
  }

  return Array.isArray(evidence.sliceJudgments);
}

function isReviewOutcome(value: unknown): boolean {
  return (
    value === "PASS" ||
    value === "WARN" ||
    value === "FAIL" ||
    value === "UNAVAILABLE" ||
    value === "SKIPPED"
  );
}

function ignore(): void {
  return;
}
