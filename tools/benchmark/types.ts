/**
 * Shared types of the public benchmark harness. Results describe the gate state a
 * repository rule reached on an author-labeled synthetic case; they are not ground
 * truth and never carry a task, a diff, a finding, or a path.
 */

/** The gate state the case author expects for the rule's own severity. */
export type ExpectedLabel = "PASS" | "WARN" | "FAIL";

/** Every state a rule result can reach, semantic or operational. */
export type ObservedOutcome = "PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE";

export type RuleSeverity = "error" | "warning";

/** One corpus case: the task text, the full patch, and the author's expected state. */
export interface BenchmarkCase {
  readonly id: string;
  readonly ruleId: string;
  readonly task: string;
  readonly diff: string;
  readonly expected: ExpectedLabel;
  readonly rationale: string;
}

export interface CorpusRule {
  readonly id: string;
  readonly severity: RuleSeverity;
}

export interface LoadedCorpus {
  readonly cases: readonly BenchmarkCase[];
  readonly rules: readonly CorpusRule[];
  readonly hash: string;
}

/** Observed result of one review of one case, with its measured cost. */
export interface CaseObservation {
  readonly caseId: string;
  readonly ruleId: string;
  readonly expected: ExpectedLabel;
  readonly observed: ObservedOutcome;
  readonly probability: number | null;
  /** Typed operational reason when the result carries no semantic judgment. */
  readonly reason: string | null;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Confusion between the author's clean cases and the outcomes that flag them. */
export interface RuleConfusion {
  /** Clean case (expected PASS) that received any warning or failure. */
  readonly falseAlarm: number;
  /** Clean case (expected PASS) that reached FAIL. */
  readonly hardFalsePositive: number;
  /** Violation case (expected FAIL) that reached PASS. */
  readonly falseNegative: number;
  /** Borderline case (expected WARN) that fell to PASS. */
  readonly missedWarning: number;
  /** Borderline case (expected WARN) that escalated to FAIL. */
  readonly overFire: number;
}

/** Per-rule accuracy summary over the accuracy pass. */
export interface RuleSummary {
  readonly ruleId: string;
  readonly severity: RuleSeverity;
  readonly cases: number;
  readonly evaluated: number;
  readonly unavailable: number;
  /** Cases whose author label is PASS: the denominator of the false-alarm rate. */
  readonly cleanCases: number;
  /** Observed state equals the author's expected state. */
  readonly exact: number;
  readonly exactRate: number | null;
  readonly confusion: RuleConfusion;
  readonly latency: LatencySummary;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface LatencySummary {
  readonly count: number;
  readonly meanMs: number | null;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
  readonly minMs: number | null;
  readonly maxMs: number | null;
}

/** One host's review-path measurement over the probe cases. */
export interface HostSummary {
  readonly host: string;
  readonly cases: readonly HostCaseResult[];
  readonly reviews: number;
  readonly latency: LatencySummary;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly responsesWithUsage: number;
  readonly meanInputTokensPerReview: number | null;
  readonly meanOutputTokensPerReview: number | null;
  /** List-price cost of one review, only when a price was supplied or defaulted. */
  readonly costUsdPerReview: number | null;
}

export interface HostCaseResult {
  readonly caseId: string;
  readonly ruleId: string;
  readonly observed: ObservedOutcome;
  readonly probability: number | null;
  readonly reason: string | null;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface PricingInput {
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
  readonly source: string;
}

export interface SafeRunMetadata {
  readonly runId: string;
  readonly generatedAt: string;
  readonly corpusHash: string;
  readonly requestedModel: string;
  readonly returnedModels: Readonly<Record<string, number>>;
  readonly repeat: number;
  readonly hosts: readonly string[];
  readonly probeCaseIds: readonly string[];
  readonly pricing: PricingInput;
}

export interface BenchmarkReport {
  readonly schemaVersion: 1;
  readonly disclaimer: string;
  readonly metadata: SafeRunMetadata;
  readonly rules: readonly RuleSummary[];
  readonly hostMeasurements: readonly HostSummary[];
  readonly observations: readonly CaseObservation[];
}
