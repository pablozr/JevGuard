import type { ParsedRule, Turn, TurnFile } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "./defaults";
import { checkFilePath } from "./safety";
import { matchesScope } from "./scope";
import type { EvidencePolicy, EvidenceSelection, TurnEvidenceSelection } from "./types";

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

  return mountEvidence(applicableFiles, policy);
}

/**
 * Selects the complete evidence for a scope-free built-in check: every attributed
 * file with a nonempty patch, with no scope filtering. Safety and size precedence
 * match rule selection so a built-in never receives partial evidence.
 */
export function selectTurnEvidence(
  turn: Turn,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): TurnEvidenceSelection {
  if (hasNoAttributedPatch(turn)) {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  const attributedFiles = turn.files.filter((file) => file.patch.trim() !== "");

  return mountEvidence(attributedFiles, policy);
}

function mountEvidence(files: readonly TurnFile[], policy: EvidencePolicy): TurnEvidenceSelection {
  const diff = assembleDiff(files);

  if (diff.trim() === "") {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  if (diff.length > policy.maxDiffLength) {
    return { status: "UNAVAILABLE", reason: "OVERSIZED_DIFF" };
  }

  if (files.some((file) => !checkFilePath(file.path, policy).allowed)) {
    return { status: "UNAVAILABLE", reason: "BLOCKED_EVIDENCE" };
  }

  return {
    status: "SELECTED",
    evidence: { files: files.map((file) => file.path), diff },
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
