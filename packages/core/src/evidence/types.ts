import type {
  EvidenceSliceKind,
  RuleEvidence,
  SkippedReason,
  UnavailableReason,
} from "../domain/types";

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
 * length in UTF-16 code units; a diff or slice exactly at the limit is accepted and a
 * longer one is never truncated. `codeExtensions` is the code/config/data class used
 * by `evidence: code`, and `docsExtensions` is the prose-documentation class used by
 * `evidence: docs`; their union is the full allowlist used by `evidence: any` and by
 * the turn-level built-ins.
 */
export interface EvidencePolicy {
  readonly maxDiffLength: number;
  readonly codeExtensions: readonly string[];
  readonly docsExtensions: readonly string[];
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

/**
 * One planned unit of repository-rule evidence. A `WHOLE` slice holds every applicable
 * file in one diff; `FILE` and `HUNK` slices each hold exactly one path. `diff` is the
 * complete rendered slice — including the repeated file preamble for a hunk — and is
 * never truncated. Slice identity and ordering are local metadata and are not sent to
 * Jev.
 */
export interface EvidenceSlice {
  readonly index: number;
  readonly kind: EvidenceSliceKind;
  readonly path: string | null;
  readonly hunkOrdinal: number | null;
  readonly files: readonly string[];
  readonly diff: string;
}

/**
 * Deterministic per-rule slice plan produced without any host or network call.
 * `SKIPPED` and `UNAVAILABLE` are operational states; `PLANNED` carries one or more
 * complete slices in attributed order.
 */
export type RuleEvidencePlan =
  | { readonly status: "SKIPPED"; readonly reason: SkippedReason }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: Extract<UnavailableReason, "OVERSIZED_DIFF" | "BLOCKED_EVIDENCE">;
    }
  | { readonly status: "PLANNED"; readonly slices: readonly EvidenceSlice[] };

/**
 * Per-rule plan after the turn's slice budget has been reserved in policy source
 * order. `SLICE_LIMIT_EXCEEDED` keeps the planned slices for observability but sends
 * no Jev call and consumes no budget.
 */
export type BudgetedRulePlan =
  | RuleEvidencePlan
  | { readonly status: "SLICE_LIMIT_EXCEEDED"; readonly slices: readonly EvidenceSlice[] };
