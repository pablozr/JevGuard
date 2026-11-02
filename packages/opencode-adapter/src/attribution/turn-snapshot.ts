import type { TurnFile } from "@jevguard/core";
import { normalizeFileDiff } from "./normalize-patch";
import type { FileContent, OpenCodeSessionFacade, WorkingFileDiff } from "./types";

/** Per-file cap for start contents and resulting patches (initial value, §10.3). */
export const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;

/** Total cap for start contents and for the attributed patch of one turn. */
export const MAX_SNAPSHOT_TOTAL_BYTES = 2 * 1024 * 1024;

/**
 * Working tree at `execution.started`: the diff against `HEAD` per file plus the
 * content of every file that was already dirty. `incomplete` means a start cap was
 * exceeded or the host truncated a patch, so the turn can never be attributed.
 */
export interface WorkingSnapshot {
  readonly diffs: ReadonlyMap<string, WorkingFileDiff>;
  readonly contents: ReadonlyMap<string, FileContent>;
  readonly incomplete: boolean;
}

/** Captures the start snapshot; rejects when the host diff or a read fails. */
export async function captureSnapshot(facade: OpenCodeSessionFacade): Promise<WorkingSnapshot> {
  const diffs = toDiffMap(await facade.snapshotWorking());
  const contents = await facade.readFiles([...diffs.keys()]);

  return { diffs, contents, incomplete: isTruncated(diffs) || !withinStartCaps(contents) };
}

/**
 * Attributes the per-file patches of one execution from its start snapshot and the
 * working-tree diff at `succeeded`. A file clean at start keeps the host patch; a file
 * dirty at start is rebuilt from its start content to its current content, so prior
 * dirt never counts as the turn's change. Returns `null` (INCOMPLETE) when any cap is
 * exceeded, a patch is truncated, or a needed content is unknown.
 */
export async function attributeSnapshotDiff(
  start: WorkingSnapshot,
  endDiffs: readonly WorkingFileDiff[],
  facade: OpenCodeSessionFacade,
): Promise<readonly TurnFile[] | null> {
  const end = toDiffMap(endDiffs);

  if (start.incomplete || isTruncated(end)) {
    return null;
  }

  const files: TurnFile[] = [];

  for (const [path, diff] of end) {
    if (!start.diffs.has(path) && diff.patch.trim() !== "") {
      files.push({ path, patch: diff.patch });
    }
  }

  const changedDirty = [...start.diffs.keys()].filter(
    (path) => end.get(path)?.patch !== start.diffs.get(path)?.patch,
  );
  const current = changedDirty.length === 0 ? new Map() : await facade.readFiles(changedDirty);

  for (const path of changedDirty) {
    const before = textOf(start.contents.get(path));
    const after = textOf(current.get(path));

    if (before === null || after === null) {
      return null;
    }

    const normalized = normalizeFileDiff({ file: path, before, after });

    if (normalized.status === "INCOMPLETE") {
      return null;
    }

    if (normalized.status === "PATCH") {
      files.push(normalized.file);
    }
  }

  return withinPatchCaps(files) ? files : null;
}

/** Every path the snapshot or the end diff mentions; used to check tool writes. */
export function diffPaths(
  start: WorkingSnapshot,
  endDiffs: readonly WorkingFileDiff[],
): Set<string> {
  return new Set([...start.diffs.keys(), ...endDiffs.map((diff) => diff.file)]);
}

function toDiffMap(diffs: readonly WorkingFileDiff[]): Map<string, WorkingFileDiff> {
  return new Map(diffs.map((diff) => [diff.file, diff]));
}

function isTruncated(diffs: ReadonlyMap<string, WorkingFileDiff>): boolean {
  return [...diffs.values()].some((diff) => diff.more === true);
}

/** A missing file reads as empty content: deleted at start or by the turn. */
function textOf(content: FileContent | undefined): string | null {
  switch (content?.kind) {
    case "TEXT":
      return content.text;
    case "MISSING":
      return "";
    default:
      return null;
  }
}

function withinStartCaps(contents: ReadonlyMap<string, FileContent>): boolean {
  let total = 0;

  for (const content of contents.values()) {
    if (content.kind === "OVERSIZED") {
      return false;
    }

    total += content.kind === "TEXT" ? byteLength(content.text) : 0;
  }

  return total <= MAX_SNAPSHOT_TOTAL_BYTES;
}

function withinPatchCaps(files: readonly TurnFile[]): boolean {
  let total = 0;

  for (const file of files) {
    const size = byteLength(file.patch);

    if (size > MAX_SNAPSHOT_FILE_BYTES) {
      return false;
    }

    total += size;
  }

  return total <= MAX_SNAPSHOT_TOTAL_BYTES;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
