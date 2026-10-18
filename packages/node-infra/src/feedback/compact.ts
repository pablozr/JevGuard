import { type FeedbackRecord, latestFeedbackRecords } from "@jevguard/core";
import { parseJsonLines } from "../history/jsonl-file";
import type { ReviewHistoryFileSystem } from "../history/types";
import { parseFeedbackRecord, serializeFeedbackRecord } from "./record";

/**
 * Keeps the latest record per FAIL identity, then drops the least recently answered
 * identities beyond `maxRecords`.
 */
export function compactFeedbackRecords(
  records: readonly FeedbackRecord[],
  maxRecords: number,
): FeedbackRecord[] {
  const latest = latestFeedbackRecords(records);

  return latest.slice(Math.max(0, latest.length - maxRecords));
}

/**
 * Rewrites the feedback file once it exceeds `maxBytes`, losslessly for the latest
 * decisions. A non-empty file without a single valid record is left untouched. Never rejects.
 */
export async function compactFeedbackFile(
  fileSystem: ReviewHistoryFileSystem,
  filePath: string,
  maxBytes: number,
  maxRecords: number,
): Promise<void> {
  try {
    const size = await fileSystem.sizeOf(filePath);

    if (size === null || size <= maxBytes) {
      return;
    }

    const contents = await fileSystem.readFile(filePath);

    if (contents === null) {
      return;
    }

    const { records, skippedLineCount } = parseJsonLines(contents, parseFeedbackRecord);

    if (records.length === 0 && skippedLineCount > 0) {
      return;
    }

    const lines = compactFeedbackRecords(records, maxRecords).map(serializeFeedbackRecord);
    const rewritten = lines.length === 0 ? "" : `${lines.join("\n")}\n`;

    await fileSystem.writeFileAtomic(filePath, rewritten);
  } catch {
    return;
  }
}
