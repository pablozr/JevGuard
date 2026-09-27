import { isAbsolute, join } from "node:path";
import type { ReviewLogEntry } from "../presentation/types";
import type {
  LocalReviewHistory,
  LocalReviewHistoryDependencies,
  ReviewHistoryPathContext,
  ReviewHistoryReadResult,
  ReviewHistoryRecord,
} from "./types";

const DATA_DIRECTORY = "jevguard";
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
      await boundGrowth();
    } catch {
      return;
    }
  }

  async function boundGrowth(): Promise<void> {
    try {
      const size = await dependencies.fileSystem.sizeOf(filePath);

      if (size === null || size <= maxBytes) {
        return;
      }

      const contents = await dependencies.fileSystem.readFile(filePath);

      if (contents === null) {
        return;
      }

      const lines = contents.split("\n").filter((line) => line.trim() !== "");
      const kept = lines.slice(Math.max(0, lines.length - maxRecords));
      const rewritten = kept.length === 0 ? "" : `${kept.join("\n")}\n`;

      await dependencies.fileSystem.writeFileAtomic(filePath, rewritten);
    } catch {
      return;
    }
  }

  async function read(): Promise<ReviewHistoryReadResult> {
    try {
      const contents = await dependencies.fileSystem.readFile(filePath);

      if (contents === null) {
        return { records: [], skippedLineCount: 0 };
      }

      return parseRecords(contents);
    } catch {
      return { records: [], skippedLineCount: 0 };
    }
  }

  return {
    append: (entry) => {
      const run = tail.then(() => append(entry));

      tail = run.then(ignore, ignore);

      return run;
    },
    read,
  };
}

/** Resolves `jevguard/reviews.jsonl` under the configured data home. */
export function resolveHistoryFilePath(context: ReviewHistoryPathContext): string {
  return join(resolveDataHome(context), DATA_DIRECTORY, HISTORY_FILENAME);
}

function resolveDataHome(context: ReviewHistoryPathContext): string {
  const configured = context.environment.get("XDG_DATA_HOME");

  if (configured !== undefined && configured !== "" && isAbsolute(configured)) {
    return configured;
  }

  return join(context.homedir, ".local", "share");
}

function parseRecords(contents: string): ReviewHistoryReadResult {
  const records: ReviewHistoryRecord[] = [];
  let skippedLineCount = 0;

  for (const line of contents.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    const parsed = parseRecord(line);

    if (parsed === null) {
      skippedLineCount += 1;
      continue;
    }

    records.push(parsed);
  }

  return { records, skippedLineCount };
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ignore(): void {
  return;
}
