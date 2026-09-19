import type { ParsedRule, Turn, TurnFile } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "./defaults";
import { checkFilePath } from "./safety";
import { matchesScope } from "./scope";
import type { EvidencePolicy, EvidenceSelection } from "./types";

/**
 * Selects the complete evidence for one rule from the turn's attributed file
 * patches. Only files matching the rule scope contribute paths and patches, the
 * assembled diff is never truncated, and the safety policy is evaluated against
 * exactly those applicable files. A blocked applicable file yields `BLOCKED_EVIDENCE`
 * rather than partial evidence.
 */
export function selectRuleEvidence(
  turn: Turn,
  rule: ParsedRule,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): EvidenceSelection {
  if (hasNoAttributedPatch(turn)) {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  const applicableFiles = selectApplicableFiles(turn.files, rule.scope);

  if (applicableFiles.length === 0) {
    return { status: "SKIPPED", reason: "NO_SCOPE_MATCH" };
  }

  const diff = assembleDiff(applicableFiles);

  if (diff.trim() === "") {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  if (diff.length > policy.maxDiffLength) {
    return { status: "UNAVAILABLE", reason: "OVERSIZED_DIFF" };
  }

  if (applicableFiles.some((file) => !checkFilePath(file.path, policy).allowed)) {
    return { status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" };
  }

  return {
    status: "SELECTED",
    evidence: { files: applicableFiles.map((file) => file.path), diff },
  };
}

function hasNoAttributedPatch(turn: Turn): boolean {
  return turn.files.every((file) => file.patch.trim() === "");
}

function selectApplicableFiles(
  files: readonly TurnFile[],
  scope: string | null,
): readonly TurnFile[] {
  if (scope === null) {
    return files;
  }

  return files.filter((file) => matchesScope(file.path, scope));
}

function assembleDiff(files: readonly TurnFile[]): string {
  return files.map((file) => file.patch).join("\n");
}
