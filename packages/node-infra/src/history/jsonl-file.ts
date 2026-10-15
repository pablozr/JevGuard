import type { ParsedJsonLines, ReviewHistoryFileSystem } from "./types";

/**
 * Rewrites a JSON Lines file once it exceeds `maxBytes`, keeping only the newest
 * `maxRecords` lines. Never rejects.
 */
export async function boundJsonLinesFile(
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

    const lines = contents.split("\n").filter((line) => line.trim() !== "");
    const kept = lines.slice(Math.max(0, lines.length - maxRecords));
    const rewritten = kept.length === 0 ? "" : `${kept.join("\n")}\n`;

    await fileSystem.writeFileAtomic(filePath, rewritten);
  } catch {
    return;
  }
}

/** Parses non-blank lines with `parseLine`; a `null` result is a skipped, counted line. */
export function parseJsonLines<T>(
  contents: string,
  parseLine: (line: string) => T | null,
): ParsedJsonLines<T> {
  const records: T[] = [];
  let skippedLineCount = 0;

  for (const line of contents.split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    const parsed = parseLine(line);

    if (parsed === null) {
      skippedLineCount += 1;
      continue;
    }

    records.push(parsed);
  }

  return { records, skippedLineCount };
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
