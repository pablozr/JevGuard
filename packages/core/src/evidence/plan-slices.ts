import type { ParsedRule, Turn, TurnFile } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "./defaults";
import { checkFilePath } from "./safety";
import { assembleDiff, hasNoAttributedPatch, selectApplicableFiles } from "./select-evidence";
import type { EvidencePolicy, EvidenceSlice, RuleEvidencePlan } from "./types";

const HUNK_MARKER = /^@@ [^\n]*@@/gm;

/**
 * Plans one rule's evidence deterministically with no host or network call. Scope and
 * evidence-class selection run first, an empty applicable diff or no scope match is
 * `SKIPPED`, and a blocked applicable path makes the whole rule
 * `UNAVAILABLE/BLOCKED_EVIDENCE` before any size work. A scoped diff at or below
 * `maxDiffLength` is one `WHOLE` slice; a larger one is split by file in attributed
 * order, with each individually oversized file split into its ordered unified-diff
 * hunks. A slice is never truncated, summarized, or omitted: an unparseable oversized
 * file or any indivisible oversized unit makes the whole rule `OVERSIZED_DIFF`.
 */
export function planRuleEvidence(
  turn: Turn,
  rule: ParsedRule,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): RuleEvidencePlan {
  if (hasNoAttributedPatch(turn)) {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  const applicableFiles = selectApplicableFiles(turn.files, rule.scope, rule.evidence, policy);

  if (applicableFiles.length === 0) {
    return { status: "SKIPPED", reason: "NO_SCOPE_MATCH" };
  }

  const diff = assembleDiff(applicableFiles);

  if (diff.trim() === "") {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  if (applicableFiles.some((file) => !checkFilePath(file.path, policy).allowed)) {
    return { status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" };
  }

  if (diff.length <= policy.maxDiffLength) {
    return { status: "PLANNED", slices: [wholeSlice(applicableFiles, diff)] };
  }

  return sliceByFile(applicableFiles, policy);
}

function wholeSlice(files: readonly TurnFile[], diff: string): EvidenceSlice {
  const paths = files.map((file) => file.path);

  return {
    index: 0,
    kind: "WHOLE",
    path: paths.length === 1 ? (paths[0] ?? null) : null,
    hunkOrdinal: null,
    files: paths,
    diff,
  };
}

function sliceByFile(files: readonly TurnFile[], policy: EvidencePolicy): RuleEvidencePlan {
  const slices: EvidenceSlice[] = [];

  for (const file of files) {
    if (file.patch.length <= policy.maxDiffLength) {
      slices.push(fileSlice(slices.length, file));
      continue;
    }

    const hunks = sliceHunks(slices.length, file, policy);

    if (hunks === null) {
      return { status: "UNAVAILABLE", reason: "OVERSIZED_DIFF" };
    }

    slices.push(...hunks);
  }

  return { status: "PLANNED", slices };
}

function fileSlice(index: number, file: TurnFile): EvidenceSlice {
  return {
    index,
    kind: "FILE",
    path: file.path,
    hunkOrdinal: null,
    files: [file.path],
    diff: file.patch,
  };
}

function sliceHunks(
  startIndex: number,
  file: TurnFile,
  policy: EvidencePolicy,
): readonly EvidenceSlice[] | null {
  const starts = hunkStarts(file.patch);

  if (starts.length === 0) {
    return null;
  }

  const firstStart = starts[0];

  if (firstStart === undefined) {
    return null;
  }

  const preamble = file.patch.slice(0, firstStart);
  const slices: EvidenceSlice[] = [];

  for (let ordinal = 0; ordinal < starts.length; ordinal += 1) {
    const start = starts[ordinal];

    if (start === undefined) {
      return null;
    }

    const end = starts[ordinal + 1] ?? file.patch.length;
    const rendered = preamble + file.patch.slice(start, end);

    if (rendered.length > policy.maxDiffLength) {
      return null;
    }

    slices.push({
      index: startIndex + ordinal,
      kind: "HUNK",
      path: file.path,
      hunkOrdinal: ordinal,
      files: [file.path],
      diff: rendered,
    });
  }

  return slices;
}

function hunkStarts(patch: string): readonly number[] {
  return Array.from(patch.matchAll(HUNK_MARKER), (match) => match.index ?? 0);
}
