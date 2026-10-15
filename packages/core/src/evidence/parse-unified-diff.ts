import type { TurnFile } from "../domain/types";
import type {
  DiffExtendedHeaders,
  DiffFormat,
  DiffHunkRead,
  DiffHunksRead,
  DiffInvalid,
  DiffLines,
  DiffParseFailureReason,
  DiffParseResult,
  DiffPaths,
  DiffSectionRead,
} from "./types";

const GIT_HEADER = "diff --git ";
const OLD_FILE_MARKER = "--- ";
const NEW_FILE_MARKER = "+++ ";
const DEV_NULL = "/dev/null";
const OLD_PREFIX = "a/";
const NEW_PREFIX = "b/";
const NO_NEWLINE_MARKER = "\\ ";
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const COMBINED_HEADERS = ["diff --cc ", "diff --combined "] as const;
const RENAME_FROM_HEADERS = ["rename from ", "copy from "] as const;
const RENAME_TO_HEADERS = ["rename to ", "copy to "] as const;
const KNOWN_EXTENDED_HEADERS = [
  "old mode ",
  "new mode ",
  "deleted file mode ",
  "new file mode ",
  "similarity index ",
  "dissimilarity index ",
  "index ",
  ...RENAME_FROM_HEADERS,
  ...RENAME_TO_HEADERS,
] as const;

/**
 * Strictly splits `git diff` output (or a plain `---`/`+++` unified diff) into
 * per-file turn patches. Each patch is the literal section text, with no content from
 * any other section. Anything not fully understood — combined diffs, preambles such as
 * `git log -p` or format-patch, renames or copies with content, unsupported or quoted
 * paths, binary patches, truncated hunks, trailing garbage — makes the whole input
 * `INVALID`, so a partial diff is never evaluated. Sections without content (pure
 * renames, mode changes) are ignored. The pass is linear in the input size.
 */
export function parseUnifiedDiff(text: string): DiffParseResult {
  const diff = splitLines(text);
  const first = diff.text.findIndex((line) => line.trim() !== "");

  if (first === -1) {
    return { status: "PARSED", files: [] };
  }

  if (diff.text.some(isCombinedHeader)) {
    return invalid("COMBINED_DIFF");
  }

  const format = detectFormat(diff.text, first);

  if (format === null) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  return collectFiles(diff, first, format);
}

function invalid(reason: DiffParseFailureReason): DiffInvalid {
  return { status: "INVALID", reason };
}

function splitLines(text: string): DiffLines {
  const raw = text.split("\n");
  const endsWithNewline = text.endsWith("\n");

  if (endsWithNewline) {
    raw.pop();
  }

  const stripped = raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

  return { raw, text: stripped, endsWithNewline };
}

function isCombinedHeader(line: string): boolean {
  return COMBINED_HEADERS.some((header) => line.startsWith(header));
}

function detectFormat(text: readonly string[], first: number): DiffFormat | null {
  if ((text[first] ?? "").startsWith(GIT_HEADER)) {
    return "GIT";
  }

  if (text.some((line) => line.startsWith(GIT_HEADER))) {
    return null;
  }

  return isPlainSectionStart(text, first) ? "PLAIN" : null;
}

function isPlainSectionStart(text: readonly string[], index: number): boolean {
  return (
    (text[index] ?? "").startsWith(OLD_FILE_MARKER) &&
    (text[index + 1] ?? "").startsWith(NEW_FILE_MARKER)
  );
}

function isSectionStart(text: readonly string[], index: number, format: DiffFormat): boolean {
  return format === "GIT"
    ? (text[index] ?? "").startsWith(GIT_HEADER)
    : isPlainSectionStart(text, index);
}

function isBlankTail(text: readonly string[], from: number): boolean {
  for (let index = from; index < text.length; index += 1) {
    if ((text[index] ?? "").trim() !== "") {
      return false;
    }
  }

  return true;
}

function collectFiles(diff: DiffLines, first: number, format: DiffFormat): DiffParseResult {
  const files: TurnFile[] = [];
  let cursor = first;

  while (cursor < diff.text.length) {
    const section =
      format === "GIT" ? readGitSection(diff, cursor) : readPlainSection(diff, cursor);

    if (section.status === "INVALID") {
      return section;
    }

    if (section.file !== null) {
      files.push(section.file);
    }

    cursor = section.next;
  }

  return { status: "PARSED", files };
}

function readGitSection(diff: DiffLines, start: number): DiffSectionRead | DiffInvalid {
  const header = parseGitHeader(diff.text[start] ?? "");

  if (header.status === "INVALID") {
    return header;
  }

  const extended = readExtendedHeaders(diff.text, start + 1);

  if (extended.status === "INVALID") {
    return extended;
  }

  if (!(diff.text[extended.next] ?? "").startsWith(OLD_FILE_MARKER)) {
    return readSectionWithoutContent(diff.text, extended.next);
  }

  const paths = readFilePaths(diff.text, extended.next, "GIT");

  if (paths.status === "INVALID") {
    return paths;
  }

  const failure = checkGitPaths(header, extended, paths);

  if (failure !== null) {
    return failure;
  }

  return readContent(diff, start, extended.next + 2, paths, "GIT");
}

function readSectionWithoutContent(
  text: readonly string[],
  index: number,
): DiffSectionRead | DiffInvalid {
  if (index >= text.length || text[index]?.startsWith(GIT_HEADER)) {
    return { status: "OK", file: null, next: index };
  }

  return isBlankTail(text, index)
    ? { status: "OK", file: null, next: text.length }
    : invalid("UNRECOGNIZED_DIFF");
}

interface GitHeaderPaths {
  readonly status: "OK";
  readonly oldPath: string;
  readonly newPath: string;
}

function parseGitHeader(line: string): GitHeaderPaths | DiffInvalid {
  const rest = line.slice(GIT_HEADER.length);

  if (rest.startsWith('"') || rest.includes(' "')) {
    return invalid("QUOTED_PATH");
  }

  if (!rest.startsWith(OLD_PREFIX)) {
    return invalid("UNSUPPORTED_PREFIX");
  }

  const split = splitGitHeaderPaths(rest);

  if (split === null) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  if (split.oldPath === "" || split.newPath === "") {
    return invalid("MISSING_PATH");
  }

  return { status: "OK", ...split };
}

function splitGitHeaderPaths(rest: string): { oldPath: string; newPath: string } | null {
  const separator = ` ${NEW_PREFIX}`;
  const pathLength = (rest.length - OLD_PREFIX.length - separator.length) / 2;

  if (Number.isInteger(pathLength) && pathLength > 0) {
    const oldPath = rest.slice(OLD_PREFIX.length, OLD_PREFIX.length + pathLength);
    const tail = rest.slice(OLD_PREFIX.length + pathLength);

    if (tail === `${separator}${oldPath}`) {
      return { oldPath, newPath: oldPath };
    }
  }

  const index = rest.indexOf(separator, OLD_PREFIX.length);

  if (index === -1) {
    return null;
  }

  return {
    oldPath: rest.slice(OLD_PREFIX.length, index),
    newPath: rest.slice(index + separator.length),
  };
}

function readExtendedHeaders(
  text: readonly string[],
  start: number,
): DiffExtendedHeaders | DiffInvalid {
  let movedFrom: string | null = null;
  let movedTo: string | null = null;
  let cursor = start;

  while (cursor < text.length) {
    const line = text[cursor] ?? "";

    if (line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) {
      return invalid("BINARY_PATCH");
    }

    const fromValue = headerValue(line, RENAME_FROM_HEADERS);
    const toValue = headerValue(line, RENAME_TO_HEADERS);

    if (fromValue?.startsWith('"') || toValue?.startsWith('"')) {
      return invalid("QUOTED_PATH");
    }

    movedFrom = fromValue ?? movedFrom;
    movedTo = toValue ?? movedTo;

    if (!KNOWN_EXTENDED_HEADERS.some((header) => line.startsWith(header))) {
      break;
    }

    cursor += 1;
  }

  return { status: "OK", next: cursor, movedFrom, movedTo };
}

function headerValue(line: string, headers: readonly string[]): string | null {
  const header = headers.find((candidate) => line.startsWith(candidate));

  return header === undefined ? null : line.slice(header.length);
}

function readFilePaths(
  text: readonly string[],
  index: number,
  format: DiffFormat,
): DiffPaths | DiffInvalid {
  const oldLine = text[index] ?? "";
  const newLine = text[index + 1] ?? "";

  if (!oldLine.startsWith(OLD_FILE_MARKER) || !newLine.startsWith(NEW_FILE_MARKER)) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  const oldValue = cutAtTab(oldLine.slice(OLD_FILE_MARKER.length));
  const newValue = cutAtTab(newLine.slice(NEW_FILE_MARKER.length));

  if (oldValue.startsWith('"') || newValue.startsWith('"')) {
    return invalid("QUOTED_PATH");
  }

  const stripped = stripPrefixes(oldValue, newValue, format);

  if (stripped === null) {
    return invalid("UNSUPPORTED_PREFIX");
  }

  if (isMissing(stripped.oldPath) && isMissing(stripped.newPath)) {
    return invalid("MISSING_PATH");
  }

  const oldPath = stripped.oldPath === DEV_NULL ? null : stripped.oldPath;
  const newPath = stripped.newPath === DEV_NULL ? null : stripped.newPath;

  if (oldPath === "" || newPath === "") {
    return invalid("MISSING_PATH");
  }

  return { status: "OK", oldPath, newPath };
}

function isMissing(path: string): boolean {
  return path === "" || path === DEV_NULL;
}

function cutAtTab(value: string): string {
  const tabIndex = value.indexOf("\t");

  return tabIndex === -1 ? value : value.slice(0, tabIndex);
}

function stripPrefixes(
  oldValue: string,
  newValue: string,
  format: DiffFormat,
): { oldPath: string; newPath: string } | null {
  const hasOldPrefix = oldValue.startsWith(OLD_PREFIX);
  const hasNewPrefix = newValue.startsWith(NEW_PREFIX);
  const oldAllowed = hasOldPrefix || oldValue === DEV_NULL;
  const newAllowed = hasNewPrefix || newValue === DEV_NULL;

  if (oldAllowed && newAllowed) {
    return {
      oldPath: hasOldPrefix ? oldValue.slice(OLD_PREFIX.length) : oldValue,
      newPath: hasNewPrefix ? newValue.slice(NEW_PREFIX.length) : newValue,
    };
  }

  if (format === "PLAIN" && !hasOldPrefix && !hasNewPrefix) {
    return { oldPath: oldValue, newPath: newValue };
  }

  return null;
}

function checkGitPaths(
  header: GitHeaderPaths,
  extended: DiffExtendedHeaders,
  paths: DiffPaths,
): DiffInvalid | null {
  const oldMatches = paths.oldPath === null || paths.oldPath === header.oldPath;
  const newMatches = paths.newPath === null || paths.newPath === header.newPath;

  if (!oldMatches || !newMatches) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  const movedByHeader =
    extended.movedFrom !== null &&
    extended.movedTo !== null &&
    extended.movedFrom !== extended.movedTo;

  if (header.oldPath !== header.newPath || movedByHeader) {
    return invalid("RENAMED_PATH");
  }

  return null;
}

function readPlainSection(diff: DiffLines, start: number): DiffSectionRead | DiffInvalid {
  const paths = readFilePaths(diff.text, start, "PLAIN");

  if (paths.status === "INVALID") {
    return paths;
  }

  if (paths.oldPath !== null && paths.newPath !== null && paths.oldPath !== paths.newPath) {
    return invalid("RENAMED_PATH");
  }

  return readContent(diff, start, start + 2, paths, "PLAIN");
}

function readContent(
  diff: DiffLines,
  start: number,
  hunksStart: number,
  paths: DiffPaths,
  format: DiffFormat,
): DiffSectionRead | DiffInvalid {
  const hunks = readHunks(diff.text, hunksStart);

  if (hunks.status === "INVALID") {
    return hunks;
  }

  const next = nextSectionIndex(diff.text, hunks.end, format);

  if (next === null) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  const path = paths.newPath ?? paths.oldPath ?? "";
  const patch = renderPatch(diff, start, hunks.end);

  return { status: "OK", file: { path, patch }, next };
}

function renderPatch(diff: DiffLines, start: number, end: number): string {
  const body = diff.raw.slice(start, end).join("\n");

  return end < diff.raw.length || diff.endsWithNewline ? `${body}\n` : body;
}

function nextSectionIndex(text: readonly string[], end: number, format: DiffFormat): number | null {
  if (end >= text.length || isSectionStart(text, end, format)) {
    return end;
  }

  return isBlankTail(text, end) ? text.length : null;
}

function readHunks(text: readonly string[], start: number): DiffHunksRead | DiffInvalid {
  let cursor = start;
  let hunkCount = 0;

  while (cursor < text.length && (text[cursor] ?? "").startsWith("@@")) {
    const hunk = readHunk(text, cursor);

    if (hunk.status === "INVALID") {
      return hunk;
    }

    cursor = hunk.next;
    hunkCount += 1;
  }

  if (hunkCount === 0) {
    return invalid(cursor >= text.length ? "TRUNCATED_HUNK" : "UNRECOGNIZED_DIFF");
  }

  return { status: "OK", end: cursor };
}

function readHunk(text: readonly string[], at: number): DiffHunkRead | DiffInvalid {
  const match = HUNK_HEADER.exec(text[at] ?? "");

  if (match === null) {
    return invalid("UNRECOGNIZED_DIFF");
  }

  let oldLeft = Number(match[2] ?? 1);
  let newLeft = Number(match[4] ?? 1);
  let cursor = at + 1;
  let afterBodyLine = false;

  while (oldLeft > 0 || newLeft > 0) {
    if (cursor >= text.length) {
      return invalid("TRUNCATED_HUNK");
    }

    const line = text[cursor] ?? "";

    if (line.startsWith(NO_NEWLINE_MARKER)) {
      if (!afterBodyLine) {
        return invalid("UNRECOGNIZED_DIFF");
      }

      afterBodyLine = false;
      cursor += 1;
      continue;
    }

    const marker = line === "" ? " " : line.charAt(0);
    const consumesOld = marker === " " || marker === "-";
    const consumesNew = marker === " " || marker === "+";

    const exceedsCount = (consumesOld && oldLeft === 0) || (consumesNew && newLeft === 0);

    if (!(consumesOld || consumesNew) || exceedsCount) {
      return invalid("UNRECOGNIZED_DIFF");
    }

    oldLeft -= consumesOld ? 1 : 0;
    newLeft -= consumesNew ? 1 : 0;
    afterBodyLine = true;
    cursor += 1;
  }

  const closesWithMarker = afterBodyLine && (text[cursor] ?? "").startsWith(NO_NEWLINE_MARKER);

  return { status: "OK", next: closesWithMarker ? cursor + 1 : cursor };
}
