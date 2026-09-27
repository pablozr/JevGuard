import type { ParsedRule, RuleEvidenceClass, RuleScope, Turn, TurnFile } from "../domain/types";
import { DEFAULT_EVIDENCE_POLICY } from "./defaults";
import { fileExtension } from "./paths";
import { checkFilePath } from "./safety";
import { matchesRuleScope } from "./scope";
import type { EvidencePolicy, EvidenceSelection, TurnEvidenceSelection } from "./types";

/**
 * Selects the complete evidence for one rule from the turn's attributed file
 * patches. Only files matching the rule scope and the rule's evidence class
 * contribute paths and patches, the assembled diff is never truncated, and the
 * safety policy is evaluated against exactly those applicable files. A blocked
 * applicable file yields `BLOCKED_EVIDENCE` rather than partial evidence.
 */
export function selectRuleEvidence(
  turn: Turn,
  rule: ParsedRule,
  policy: EvidencePolicy = DEFAULT_EVIDENCE_POLICY,
): EvidenceSelection {
  if (hasNoAttributedPatch(turn)) {
    return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };
  }

  const applicableFiles = selectApplicableFiles(turn.files, rule.scope, rule.evidence, policy);

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

export function hasNoAttributedPatch(turn: Turn): boolean {
  return turn.files.every((file) => file.patch.trim() === "");
}

export function selectApplicableFiles(
  files: readonly TurnFile[],
  scope: RuleScope | null,
  evidenceClass: RuleEvidenceClass,
  policy: EvidencePolicy,
): readonly TurnFile[] {
  const scoped =
    scope === null ? files : files.filter((file) => matchesRuleScope(file.path, scope));

  return scoped.filter((file) => isInEvidenceClass(file.path, evidenceClass, policy));
}

/**
 * Class filtering removes a file only when its extension belongs to the other
 * evidence class. A denied sensitive path is always kept, and a file whose extension
 * is in neither class (unknown or denied-extension) is kept too, so the existing
 * blocked-evidence check still rejects them instead of silently omitting them from
 * the diff.
 */
function isInEvidenceClass(
  path: string,
  evidenceClass: RuleEvidenceClass,
  policy: EvidencePolicy,
): boolean {
  if (evidenceClass === "any") {
    return true;
  }

  const safety = checkFilePath(path, policy);

  if (!safety.allowed && safety.reason === "DENIED_SENSITIVE_PATH") {
    return true;
  }

  const extension = fileExtension(path);
  const otherClass = evidenceClass === "code" ? policy.docsExtensions : policy.codeExtensions;

  return !otherClass.includes(extension);
}

export function assembleDiff(files: readonly TurnFile[]): string {
  return files.map((file) => file.patch).join("\n");
}
