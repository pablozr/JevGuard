import type { ReviewResult, SemanticVerdict } from "../domain/types";
import type { GateConfigResult } from "../gate/types";
import type { JevEvaluationPort, PolicyConfigParser, PolicyLoader } from "../ports/types";
import type { RemediationConfigResult } from "../remediation/types";
import type { RuleParseResults } from "../rules/types";

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

/** One turn's results across lanes in source order plus their aggregate summary. */
export interface TurnReview {
  readonly turnId: string;
  readonly results: readonly ReviewResult[];
  readonly summary: ReviewSummary;
}

export interface ReviewTurnDependencies {
  readonly policy: PolicyLoader;
  readonly parseConfig: PolicyConfigParser;
  readonly jev: JevEvaluationPort;
}

/** The aggregate review plus what a host needs to build a remediation proposal. */
export interface TurnReviewOutcome {
  readonly review: TurnReview;
  readonly rules: RuleParseResults;
  readonly remediation: RemediationConfigResult;
}

export type ConfigValue =
  | { readonly status: "VALUE"; readonly value: unknown }
  | { readonly status: "INVALID" };

/** Rule-lane results plus the parsed rule provenance the review result omits. */
export interface RuleLaneReview {
  readonly results: readonly ReviewResult[];
  readonly rules: RuleParseResults;
}

/** Both validated configuration sections read from one `.jev/config.yaml` value. */
export interface PolicyConfig {
  readonly gate: GateConfigResult;
  readonly remediation: RemediationConfigResult;
}
