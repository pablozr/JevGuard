export interface JevRuleCriteria {
  readonly id: string;
  readonly description: string;
  readonly violation: string;
  readonly allowed?: string;
}

export interface JevChange {
  readonly files: readonly string[];
  readonly diff: string;
}

/**
 * State for one rule judgment. One applicable rule maps to exactly one Noul;
 * `allowed` stays inside the same criteria.
 */
export interface JevRequest {
  readonly task: string;
  readonly rule: JevRuleCriteria;
  readonly change: JevChange;
}

export interface JevNoul {
  /** Probability that the attributed change violates the rule, in `[0, 1]`. */
  readonly violationProbability: number;
}

export type JevFailureReason = "MISSING_CREDENTIAL" | "API_ERROR" | "INVALID_RESPONSE";

export type JevEvaluationResult =
  | { readonly status: "EVALUATED"; readonly noul: JevNoul }
  | { readonly status: "FAILED"; readonly reason: JevFailureReason };

/**
 * Port for a single Jev judgment. Adapters own the transport and validate responses;
 * failures are typed and never thrown.
 */
export interface JevEvaluationPort {
  evaluate(request: JevRequest): Promise<JevEvaluationResult>;
}

/**
 * Raw `.jev` policy text. `null` config selects documented defaults; `null` rules
 * makes the review `UNAVAILABLE`.
 */
export interface PolicySource {
  readonly rules: string | null;
  readonly config: string | null;
}

/**
 * Port for loading policy text. Implementations read files and must not parse them.
 */
export interface PolicySourcePort {
  load(): Promise<PolicySource>;
}
