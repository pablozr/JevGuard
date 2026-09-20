export interface JevRuleCriteria {
  readonly id: string;
  readonly description: string;
  readonly violation: string;
  readonly allowed?: string;
}

/**
 * One Noul question. `instructions` states the judgment in English; `criteria`
 * carries the policy text. A rule and a built-in share this shape.
 */
export interface JevNoulQuestion {
  readonly type: "noul";
  readonly instructions: string;
  readonly criteria: JevRuleCriteria;
}

export interface JevChange {
  readonly files: readonly string[];
  readonly diff: string;
}

/**
 * Internal answer IDs for the built-in batch. Request and result share these names
 * so no lane repeats the string literals.
 */
export const SCOPE_CREEP_ANSWER = "scopeCreep";
export const COMPLEXITY_ANSWER = "complexity";

/**
 * State for one rule judgment. One applicable rule maps to exactly one Noul;
 * `allowed` stays inside the same criteria.
 */
export interface JevRuleRequest {
  readonly kind: "RULE";
  readonly task: string;
  readonly question: JevNoulQuestion;
  readonly change: JevChange;
}

/**
 * State for the single built-in batch. Two independent named Nouls share one task
 * and one change, so one request answers both checks.
 */
export interface JevBuiltInBatchRequest {
  readonly kind: "BUILT_IN_BATCH";
  readonly task: string;
  readonly questions: {
    readonly scopeCreep: JevNoulQuestion;
    readonly complexity: JevNoulQuestion;
  };
  readonly change: JevChange;
}

export type JevRequest = JevRuleRequest | JevBuiltInBatchRequest;

export interface JevNoul {
  /** Probability that the attributed change violates the policy, in `[0, 1]`. */
  readonly violationProbability: number;
}

export type JevFailureReason = "MISSING_CREDENTIAL" | "API_ERROR" | "INVALID_RESPONSE";

export type JevRuleEvaluationResult =
  | { readonly kind: "RULE"; readonly status: "EVALUATED"; readonly noul: JevNoul }
  | { readonly kind: "RULE"; readonly status: "FAILED"; readonly reason: JevFailureReason };

/**
 * One named answer inside a usable batch envelope. A malformed, missing, or
 * out-of-range sibling fails alone and never discards the other answer.
 */
export type JevBuiltInAnswerResult =
  | { readonly status: "EVALUATED"; readonly noul: JevNoul }
  | { readonly status: "FAILED"; readonly reason: JevFailureReason };

/**
 * Batch result. `FAILED` means the envelope carried no usable answers at all;
 * `EVALUATED` carries each named answer's own result.
 */
export type JevBuiltInBatchResult =
  | {
      readonly kind: "BUILT_IN_BATCH";
      readonly status: "EVALUATED";
      readonly answers: {
        readonly scopeCreep: JevBuiltInAnswerResult;
        readonly complexity: JevBuiltInAnswerResult;
      };
    }
  | {
      readonly kind: "BUILT_IN_BATCH";
      readonly status: "FAILED";
      readonly reason: JevFailureReason;
    };

export type JevEvaluationResult = JevRuleEvaluationResult | JevBuiltInBatchResult;

/**
 * Port for Jev judgments. Adapters own the transport and validate responses;
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
