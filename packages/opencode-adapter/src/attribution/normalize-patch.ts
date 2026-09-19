import type { OpenCodeFileDiff, PatchNormalization } from "./types";

/**
 * Uses a provided `patch` verbatim, otherwise rebuilds a conservative unified
 * patch from full `before`/`after`. Missing or incomplete content is
 * `INCOMPLETE`, never partial evidence.
 */
export function normalizeFileDiff(diff: OpenCodeFileDiff): PatchNormalization {
  const path = typeof diff.file === "string" ? diff.file.trim() : "";

  if (path === "") {
    return { status: "INCOMPLETE" };
  }

  if (typeof diff.patch === "string" && diff.patch.trim() !== "") {
    return { status: "PATCH", file: { path, patch: diff.patch } };
  }

  const before = diff.before;
  const after = diff.after;

  if (typeof before !== "string" || typeof after !== "string") {
    return { status: "INCOMPLETE" };
  }

  if (before === after) {
    return { status: "EMPTY" };
  }

  return { status: "PATCH", file: { path, patch: buildReplacementPatch(path, before, after) } };
}

function buildReplacementPatch(path: string, before: string, after: string): string {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const fromPath = beforeLines.length === 0 ? "/dev/null" : `a/${path}`;
  const toPath = afterLines.length === 0 ? "/dev/null" : `b/${path}`;
  const header = `--- ${fromPath}\n+++ ${toPath}`;
  const range = `@@ -${hunkStart(beforeLines.length)},${beforeLines.length} +${hunkStart(afterLines.length)},${afterLines.length} @@`;
  const removed = beforeLines.map((line) => `-${line}`);
  const added = afterLines.map((line) => `+${line}`);

  return [header, range, ...removed, ...added, ""].join("\n");
}

function splitLines(text: string): readonly string[] {
  if (text === "") {
    return [];
  }

  const lines = text.split("\n");

  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function hunkStart(lineCount: number): number {
  return lineCount === 0 ? 0 : 1;
}
