import type { TurnReview } from "@jevguard/core";
import type { DeliveryStatus, StructuredLogSink } from "@jevguard/node-infra";

export type ToastVariant = "info" | "success" | "warning" | "error";

export interface ReviewToast {
  readonly title: string;
  readonly message: string;
  readonly variant: ToastVariant;
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
 * Typed reason code for one contained automatic-proposal failure. It is the only
 * failure detail that may be logged: no task, diff, rule, finding, path, or
 * credential is ever attached to a failure.
 */
export type ProposalFailureReason =
  | "MODEL_SPECIFIER_INVALID"
  | "CHILD_SESSION_FAILED"
  | "PROPOSAL_PROMPT_FAILED";

/**
 * Safe, transient status surface for the automatic proposal. It carries no rule,
 * task, diff, finding, or secret; only generic lifecycle messages: the proposal is
 * being prepared in the child session, then that it is ready, or that it failed.
 */
export interface RemediationNotifier {
  proposalPreparing(): Promise<DeliveryStatus>;
  proposalReady(): Promise<DeliveryStatus>;
  proposalFailed(): Promise<DeliveryStatus>;
}

/**
 * Safe failure-log surface for the automatic proposal. `write` records exactly one
 * typed reason code and nothing else; every delivery failure is contained as
 * `FAILED` and never throws.
 */
export interface RemediationFailureLogSink {
  write(reason: ProposalFailureReason): Promise<DeliveryStatus>;
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
