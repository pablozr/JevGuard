import type {
  OperationalStatus,
  ReviewCounts,
  RuleSeverity,
  SemanticVerdict,
  SkippedReason,
  TurnReview,
  UnavailableReason,
} from "@jevguard/core";

export type ToastVariant = "info" | "success" | "warning" | "error";

export type DeliveryStatus = "DELIVERED" | "FAILED";

interface RuleLogIdentity {
  readonly kind: "RULE";
  readonly ruleId: string | null;
  readonly severity: RuleSeverity | null;
  readonly scopedPaths: readonly string[];
}

interface BuiltInLogIdentity {
  readonly kind: "BUILT_IN";
  readonly checkId: string;
  readonly severity: RuleSeverity;
  readonly scopedPaths: readonly string[];
}

interface ReviewLogIdentity {
  readonly kind: "REVIEW";
}

type SemanticLogResult = {
  readonly outcome: SemanticVerdict;
  readonly violationProbability: number;
};

type OperationalLogResult = {
  readonly outcome: OperationalStatus;
  readonly reason: SkippedReason | UnavailableReason;
};

/**
 * Nested per-result aggregate-log payload with an exact allowlist. The `kind`
 * discriminant selects the identity fields: a rule carries `ruleId`, a built-in
 * carries `checkId`, and a review-level result carries neither. Semantic outcomes
 * carry the raw probability; operational outcomes carry the typed reason.
 */
export type ReviewLogResult =
  | (RuleLogIdentity & SemanticLogResult)
  | (RuleLogIdentity & OperationalLogResult)
  | (BuiltInLogIdentity & SemanticLogResult)
  | (BuiltInLogIdentity & OperationalLogResult)
  | (ReviewLogIdentity & OperationalLogResult);

/** Aggregate summary projection for the structured log; `verdict` maps to `highestVerdict`. */
export interface ReviewLogSummary {
  readonly highestVerdict: SemanticVerdict | null;
  readonly hasUnavailable: boolean;
  readonly counts: ReviewCounts;
}

/** Exact structured-log allowlist for one aggregate turn review. */
export interface ReviewLogEntry {
  readonly turnId: string;
  readonly summary: ReviewLogSummary;
  readonly results: readonly ReviewLogResult[];
}

export interface ReviewToast {
  readonly title: string;
  readonly message: string;
  readonly variant: ToastVariant;
}

export interface StructuredLogSink {
  write(entry: ReviewLogEntry): Promise<DeliveryStatus>;
}

export interface ToastSink {
  show(toast: ReviewToast): Promise<DeliveryStatus>;
}

export interface PresentationPorts {
  readonly log: StructuredLogSink;
  readonly toast: ToastSink;
}

export interface PresentationDelivery {
  readonly log: DeliveryStatus;
  readonly toast: DeliveryStatus;
}

export interface ReviewPresenter {
  present(review: TurnReview): Promise<PresentationDelivery>;
}

/**
 * Safe, transient status surface for the automatic proposal. It carries no rule,
 * task, diff, finding, or secret; only generic lifecycle messages: the proposal is
 * being prepared in the child session, and then that it is ready.
 */
export interface RemediationNotifier {
  proposalPreparing(): Promise<DeliveryStatus>;
  proposalReady(): Promise<DeliveryStatus>;
}

/**
 * Safe TUI navigation surface for the automatic proposal. It moves the client to
 * the proposal's child session and carries no rule, task, diff, finding, or secret.
 * Every delivery failure is contained as `FAILED`.
 */
export interface ProposalSessionNavigator {
  navigate(sessionID: string): Promise<DeliveryStatus>;
}

export interface OpenCodeLogInput {
  readonly body: {
    readonly service: string;
    readonly level: "debug" | "info" | "error" | "warn";
    readonly message: string;
    readonly extra: Readonly<Record<string, unknown>>;
  };
}

export interface OpenCodeLogResult {
  readonly error?: unknown;
}

export interface OpenCodeToastInput {
  readonly body: {
    readonly title: string;
    readonly message: string;
    readonly variant: ToastVariant;
    readonly duration: number;
  };
}

export interface OpenCodeToastResult {
  readonly error?: unknown;
}

export interface OpenCodeSessionSelectInput {
  readonly sessionID: string;
}

export interface OpenCodeSessionSelectResult {
  readonly error?: unknown;
}

/**
 * Narrow OpenCode client surface for presentation. Structural typing keeps the
 * adapter decoupled from the SDK runtime and lets tests fake log/toast/navigation
 * delivery.
 */
export interface OpenCodePresentationClient {
  readonly app: {
    log(input: OpenCodeLogInput): Promise<OpenCodeLogResult>;
  };
  readonly tui: {
    showToast(input: OpenCodeToastInput): Promise<OpenCodeToastResult>;
    selectSession(input: OpenCodeSessionSelectInput): Promise<OpenCodeSessionSelectResult>;
  };
}
