import type { RuleReviewResult, SemanticVerdict } from "../domain/types";

/** Per-outcome counts over every rule result in a turn review. */
export interface ReviewCounts {
  readonly pass: number;
  readonly warn: number;
  readonly fail: number;
  readonly skipped: number;
  readonly unavailable: number;
}

/**
 * Turn-level summary. `verdict` is the highest semantic outcome across all rules,
 * ignoring operational states, and is `null` when no rule reached a verdict.
 * `hasUnavailable` keeps missing judgments visible without turning them into a
 * verdict.
 */
export interface ReviewSummary {
  readonly verdict: SemanticVerdict | null;
  readonly hasUnavailable: boolean;
  readonly counts: ReviewCounts;
}

/** One turn's per-rule results in source order plus their aggregate summary. */
export interface TurnReview {
  readonly turnId: string;
  readonly results: readonly RuleReviewResult[];
  readonly summary: ReviewSummary;
}
