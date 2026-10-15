import { join } from "node:path";
import type { FailIdentity, FeedbackRecord, FeedbackSelection } from "@jevguard/core";
import { resolveJevGuardDataDirectory } from "../history/data-directory";
import { boundJsonLinesFile, isObject, parseJsonLines } from "../history/jsonl-file";
import type { ReviewHistoryPathContext } from "../history/types";
import type {
  FeedbackReadResult,
  FeedbackSelectionReadResult,
  FeedbackWriteStatus,
  LocalFeedbackStore,
  LocalFeedbackStoreDependencies,
} from "./types";

const FEEDBACK_FILENAME = "feedback.jsonl";
const SELECTION_FILENAME = "feedback-selection.json";
const MAX_FIELD_LENGTH = 1024;
const MAX_SELECTION_ITEMS = 1000;
const RECORD_KEY_COUNT = 4;

/** Rewrite the feedback file once it grows past this many bytes, keeping the newest lines. */
export const DEFAULT_FEEDBACK_MAX_BYTES = 1024 * 1024;

/** Number of newest decisions retained by a bounded rewrite. */
export const DEFAULT_FEEDBACK_MAX_RECORDS = 5000;

/** Builds the local JSON Lines feedback store plus the last-listing selection snapshot. */
export function createLocalFeedbackStore(
  dependencies: LocalFeedbackStoreDependencies,
): LocalFeedbackStore {
  const { fileSystem } = dependencies;
  const filePath = resolveFeedbackFilePath(dependencies.context);
  const selectionPath = resolveFeedbackSelectionFilePath(dependencies.context);
  const maxBytes = dependencies.maxBytes ?? DEFAULT_FEEDBACK_MAX_BYTES;
  const maxRecords = dependencies.maxRecords ?? DEFAULT_FEEDBACK_MAX_RECORDS;

  async function read(): Promise<FeedbackReadResult> {
    try {
      const contents = await fileSystem.readFile(filePath);

      return { status: "READ", ...parseJsonLines(contents ?? "", parseRecord) };
    } catch {
      return { status: "FAILED" };
    }
  }

  async function append(record: FeedbackRecord): Promise<FeedbackWriteStatus> {
    try {
      const line = JSON.stringify({
        turnId: record.turnId,
        ruleId: record.ruleId,
        decision: record.decision,
        timestamp: record.timestamp,
      });

      await fileSystem.ensureParentDirectory(filePath);
      await fileSystem.appendFile(filePath, `${line}\n`);
    } catch {
      return "FAILED";
    }

    await boundJsonLinesFile(fileSystem, filePath, maxBytes, maxRecords);

    return "WRITTEN";
  }

  async function readSelection(): Promise<FeedbackSelectionReadResult> {
    try {
      const contents = await fileSystem.readFile(selectionPath);

      return { status: "READ", selection: contents === null ? null : parseSelection(contents) };
    } catch {
      return { status: "FAILED" };
    }
  }

  async function writeSelection(selection: FeedbackSelection): Promise<FeedbackWriteStatus> {
    try {
      const snapshot: FeedbackSelection = {
        version: 1,
        listedAt: selection.listedAt,
        items: selection.items.map((item) => ({ turnId: item.turnId, ruleId: item.ruleId })),
      };

      await fileSystem.ensureParentDirectory(selectionPath);
      await fileSystem.writeFileAtomic(selectionPath, `${JSON.stringify(snapshot)}\n`);

      return "WRITTEN";
    } catch {
      return "FAILED";
    }
  }

  return { read, append, readSelection, writeSelection };
}

/** Resolves `jevguard/feedback.jsonl` under the configured data home. */
export function resolveFeedbackFilePath(context: ReviewHistoryPathContext): string {
  return join(resolveJevGuardDataDirectory(context), FEEDBACK_FILENAME);
}

/** Resolves `jevguard/feedback-selection.json` under the configured data home. */
export function resolveFeedbackSelectionFilePath(context: ReviewHistoryPathContext): string {
  return join(resolveJevGuardDataDirectory(context), SELECTION_FILENAME);
}

function parseRecord(line: string): FeedbackRecord | null {
  const value = parseJson(line);

  if (!isObject(value) || Object.keys(value).length !== RECORD_KEY_COUNT) {
    return null;
  }

  const { turnId, ruleId, decision, timestamp } = value;

  if (!isBoundedString(turnId) || !isBoundedString(ruleId) || !isBoundedString(timestamp)) {
    return null;
  }

  if ((decision !== "RIGHT" && decision !== "WRONG") || Number.isNaN(Date.parse(timestamp))) {
    return null;
  }

  return { turnId, ruleId, decision, timestamp };
}

function parseSelection(contents: string): FeedbackSelection | null {
  const value = parseJson(contents);

  if (!isObject(value) || value.version !== 1 || typeof value.listedAt !== "string") {
    return null;
  }

  const { items } = value;

  if (!Array.isArray(items) || items.length > MAX_SELECTION_ITEMS) {
    return null;
  }

  const identities: FailIdentity[] = [];

  for (const item of items) {
    if (!isObject(item) || !isBoundedString(item.turnId) || !isBoundedString(item.ruleId)) {
      return null;
    }

    identities.push({ turnId: item.turnId, ruleId: item.ruleId });
  }

  return { version: 1, listedAt: value.listedAt, items: identities };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_FIELD_LENGTH;
}
