import { join } from "node:path";
import { resolveJevGuardDataDirectory } from "../history/data-directory";
import { boundJsonLinesFile, isObject, parseJsonLines } from "../history/jsonl-file";
import type { ReviewHistoryFileSystem, ReviewHistoryPathContext } from "../history/types";

const ACKS_FILENAME = "enforce-acks.jsonl";
const MAX_FIELD_LENGTH = 128;
const MAX_RULE_IDS = 32;
const RECORD_KEY_COUNT = 3;

/** Rewrite the acknowledgement ledger once it grows past this many bytes. */
export const DEFAULT_ACKS_MAX_BYTES = 256 * 1024;

/** Number of newest acknowledgements retained by a bounded rewrite. */
export const DEFAULT_ACKS_MAX_RECORDS = 1000;

/**
 * One acknowledgement: the unit the user silenced and the rules that blocked it. Only
 * the token, the rule IDs and the timestamp are kept — no diff, task, path or text.
 */
export interface EnforceAckRecord {
  readonly turnId: string;
  readonly ruleIds: readonly string[];
  readonly timestamp: string;
}

/** Parsed ledger plus how many malformed lines were skipped; an I/O error is `FAILED`. */
export type EnforceAckReadResult =
  | {
      readonly status: "READ";
      readonly records: readonly EnforceAckRecord[];
      readonly skippedLineCount: number;
    }
  | { readonly status: "FAILED" };

export type EnforceAckWriteStatus = "WRITTEN" | "FAILED";

/**
 * Local acknowledgement ledger. It never throws: every I/O failure resolves to a status
 * so the gate and the CLI can fail open. Only the allowlisted fields are written.
 */
export interface LocalEnforceAckStore {
  read(): Promise<EnforceAckReadResult>;
  append(record: EnforceAckRecord): Promise<EnforceAckWriteStatus>;
}

export interface LocalEnforceAckStoreDependencies {
  readonly context: ReviewHistoryPathContext;
  readonly fileSystem: ReviewHistoryFileSystem;
  readonly maxBytes?: number;
  readonly maxRecords?: number;
}

/** Builds the local acknowledgement ledger next to the review history. */
export function createLocalEnforceAckStore(
  dependencies: LocalEnforceAckStoreDependencies,
): LocalEnforceAckStore {
  const { fileSystem } = dependencies;
  const filePath = resolveEnforceAcksFilePath(dependencies.context);
  const maxBytes = dependencies.maxBytes ?? DEFAULT_ACKS_MAX_BYTES;
  const maxRecords = dependencies.maxRecords ?? DEFAULT_ACKS_MAX_RECORDS;

  return {
    async read(): Promise<EnforceAckReadResult> {
      try {
        const contents = await fileSystem.readFile(filePath);

        return { status: "READ", ...parseJsonLines(contents ?? "", parseAckRecord) };
      } catch {
        return { status: "FAILED" };
      }
    },
    async append(record: EnforceAckRecord): Promise<EnforceAckWriteStatus> {
      try {
        const line = serializeAckRecord(record);

        await fileSystem.ensureParentDirectory(filePath);
        await fileSystem.appendFile(filePath, `${line}\n`);
      } catch {
        return "FAILED";
      }

      await boundJsonLinesFile(fileSystem, filePath, maxBytes, maxRecords);

      return "WRITTEN";
    },
  };
}

/** Resolves `jevguard/enforce-acks.jsonl` under the configured data home. */
export function resolveEnforceAcksFilePath(context: ReviewHistoryPathContext): string {
  return join(resolveJevGuardDataDirectory(context), ACKS_FILENAME);
}

/** Parses one ledger line; anything but the three allowlisted fields is `null`. */
export function parseAckRecord(line: string): EnforceAckRecord | null {
  const value = parseJson(line);

  if (!isObject(value) || Object.keys(value).length !== RECORD_KEY_COUNT) {
    return null;
  }

  const { turnId, ruleIds, timestamp } = value;

  if (
    !isBoundedString(turnId) ||
    !isBoundedString(timestamp) ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    return null;
  }

  if (!Array.isArray(ruleIds) || ruleIds.length === 0 || ruleIds.length > MAX_RULE_IDS) {
    return null;
  }

  const ids: string[] = [];

  for (const ruleId of ruleIds) {
    if (!isBoundedString(ruleId)) return null;

    ids.push(ruleId);
  }

  return { turnId, ruleIds: ids, timestamp };
}

/** Serializes only the three allowlisted fields, in order, without the trailing newline. */
export function serializeAckRecord(record: EnforceAckRecord): string {
  return JSON.stringify({
    turnId: record.turnId,
    ruleIds: record.ruleIds,
    timestamp: record.timestamp,
  });
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
