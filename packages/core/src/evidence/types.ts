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
