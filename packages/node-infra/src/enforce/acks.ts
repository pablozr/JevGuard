import { join } from "node:path";
import { resolveJevGuardDataDirectory } from "../history/data-directory";
import { boundJsonLinesFile, isObject, parseJsonLines } from "../history/jsonl-file";
import type { ReviewHistoryFileSystem, ReviewHistoryPathContext } from "../history/types";

const ACKS_FILENAME = "enforce-acks.jsonl";
const RECORD_KEY_COUNT = 3;

/**
 * The longest a stored field may be. A record that does not fit is refused by the writer
 * as well as by the parser, so the ledger never holds a line its own reader skips.
 */
export const MAX_ACK_FIELD_LENGTH = 128;

/** The most rule IDs one record may keep; a unit with more is written with the first 32. */
export const MAX_ACK_RULE_IDS = 32;

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
      // The writer and the reader must accept the same records: a line the parser would
      // skip is not written at all, so an acknowledgement never claims to be recorded
      // while the next read silently drops it.
      if (!isAckRecord(record)) return "FAILED";

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

  if (!Array.isArray(ruleIds) || ruleIds.length === 0 || ruleIds.length > MAX_ACK_RULE_IDS) {
    return null;
  }

  const ids: string[] = [];

  for (const ruleId of ruleIds) {
    if (!isBoundedString(ruleId)) return null;

    ids.push(ruleId);
  }

  return { turnId, ruleIds: ids, timestamp };
}

/**
 * `true` when the record is one the parser would keep: the same bounds, applied before a
 * write so a record the reader cannot read is refused instead of stored and skipped.
 */
export function isAckRecord(record: EnforceAckRecord): boolean {
  return (
    isBoundedString(record.turnId) &&
    isBoundedString(record.timestamp) &&
    !Number.isNaN(Date.parse(record.timestamp)) &&
    record.ruleIds.length > 0 &&
    record.ruleIds.length <= MAX_ACK_RULE_IDS &&
    record.ruleIds.every((ruleId) => isBoundedString(ruleId))
  );
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
  return typeof value === "string" && value !== "" && value.length <= MAX_ACK_FIELD_LENGTH;
}
