import type { RuleEvidence, SkippedReason, UnavailableReason } from "../domain/types";

export type EvidenceUnavailableReason = Extract<
  UnavailableReason,
  "OVERSIZED_DIFF" | "BLOCKED_EVIDENCE"
>;

export type FileRejectionReason = "DENIED_SENSITIVE_PATH" | "EXTENSION_NOT_ALLOWED";

export type PathSafety =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: FileRejectionReason };

/**
 * Deterministic evidence-safety policy. `maxDiffLength` counts JavaScript string
 * length in UTF-16 code units; a diff exactly at the limit is accepted and a longer
 * diff is never truncated.
 */
export interface EvidencePolicy {
  readonly maxDiffLength: number;
  readonly allowedExtensions: readonly string[];
  readonly deniedFileNames: readonly string[];
  readonly deniedExtensions: readonly string[];
  readonly deniedDirectoryNames: readonly string[];
}

/**
 * Result of selecting one rule's evidence. `SELECTED` carries the complete,
 * untruncated attributed diff; `SKIPPED` and `UNAVAILABLE` are operational states,
 * never semantic verdicts.
 */
export type EvidenceSelection =
  | { readonly status: "SELECTED"; readonly evidence: RuleEvidence }
  | { readonly status: "SKIPPED"; readonly reason: SkippedReason }
  | { readonly status: "UNAVAILABLE"; readonly reason: EvidenceUnavailableReason };

/**
 * Result of selecting the turn's evidence for a scope-free built-in check. There is
 * no scope, so `NO_SCOPE_MATCH` cannot occur and every attributed nonempty file is
 * treated as applicable.
 */
export type TurnEvidenceSelection =
  | { readonly status: "SELECTED"; readonly evidence: RuleEvidence }
  | { readonly status: "SKIPPED"; readonly reason: Extract<SkippedReason, "NO_ATTRIBUTED_PATCH"> }
  | { readonly status: "UNAVAILABLE"; readonly reason: EvidenceUnavailableReason };
