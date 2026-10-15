/** The user's local verdict on a rule FAIL: a real violation or a false alarm. */
export type FeedbackDecision = "RIGHT" | "WRONG";

/**
 * Identity of one rule FAIL: the turn it came from and the rule that failed. Only
 * identifiers are ever stored, never task, diff, findings, paths, or credentials.
 */
export interface FailIdentity {
  readonly turnId: string;
  readonly ruleId: string;
}

/** One persisted decision: the FAIL identity, the decision, and an ISO 8601 timestamp. */
export interface FeedbackRecord extends FailIdentity {
  readonly decision: FeedbackDecision;
  readonly timestamp: string;
}

/** A rule FAIL found in the review history, with the data shown when listing it. */
export interface RuleFail extends FailIdentity {
  readonly timestamp: string;
  readonly violationProbability: number;
}

/** Unanswered FAILs to show, newest first, plus how many are pending in total. */
export interface PendingFailList {
  readonly items: readonly RuleFail[];
  readonly total: number;
}

/**
 * Snapshot of the identities shown by the last listing, in display order. It pins
 * what each number means so later FAILs or answers never shift it.
 */
export interface FeedbackSelection {
  readonly version: 1;
  readonly listedAt: string;
  readonly items: readonly FailIdentity[];
}

/** Outcome of mapping a listed number back to a FAIL still present in the history. */
export type FeedbackTargetResolution =
  | { readonly status: "FOUND"; readonly fail: RuleFail }
  | { readonly status: "NO_SELECTION" }
  | { readonly status: "NUMBER_OUT_OF_RANGE" }
  | { readonly status: "NO_LONGER_IN_HISTORY" };

/** Whether an answer needs a new record; the latest decision for a FAIL wins. */
export type FeedbackDecisionPlan =
  | { readonly status: "RECORD"; readonly previous: FeedbackDecision | null }
  | { readonly status: "UNCHANGED" };
