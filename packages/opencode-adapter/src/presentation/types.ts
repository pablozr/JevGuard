import type { ChainStopCode, TurnReview } from "@jevguard/core";
import type { DeliveryStatus, StructuredLogSink } from "@jevguard/node-infra";
import type { AttributionFailureReason } from "../attribution/types";

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
  | "PROPOSAL_PROMPT_FAILED"
  | "REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL"
  | "REMEDIATION_PROPOSAL_TIMEOUT";

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
 * Navigation to the proposal's child session. The OpenCode 2.2.x server plugin has
 * no TUI surface, so the concrete navigator is a no-op until the `./tui` phase.
 */
export interface ProposalSessionNavigator {
  navigate(sessionID: string): Promise<DeliveryStatus>;
}

/**
 * Operational lines that are not a review: an execution skipped because it was
 * interrupted or failed, or an attribution failure. They carry only the typed code.
 */
export type OperationalEvent =
  | { readonly kind: "TURN_SKIPPED"; readonly reason: "interrupted" | "failed" }
  | { readonly kind: "ATTRIBUTION_UNAVAILABLE"; readonly reason: AttributionFailureReason }
  | RemediationChainEvent;

/**
 * One step of a remediation chain, as the log shows it: ids, counts and typed codes only.
 * `REMEDIATION_CONFIG_INVALID` says the user's `opencode.yaml` was refused, so remediation
 * stays off.
 */
export type RemediationChainEvent =
  | {
      readonly kind: "REMEDIATION_SENT";
      readonly chainId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
    }
  | {
      readonly kind: "REMEDIATION_STOPPED";
      readonly chainId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly code: ChainStopCode;
    }
  | {
      readonly kind: "REMEDIATION_RESOLVED";
      readonly chainId: string;
      readonly fixed: number;
      readonly attempts: number;
    }
  | { readonly kind: "REMEDIATION_CONFIG_INVALID"; readonly reason: string };

export interface OperationalLogSink {
  write(event: OperationalEvent): Promise<DeliveryStatus>;
}

/** One structured log record; `extra` holds only allowlisted fields. */
export interface OpenCodeLogRecord {
  readonly service: string;
  readonly level: "debug" | "info" | "error" | "warn";
  readonly message: string;
  readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * Destination of structured log records. The 2.2.x server plugin context has no log
 * API, so the default writer prints one JSON line to standard error.
 */
export interface OpenCodeLogWriter {
  write(record: OpenCodeLogRecord): void | Promise<void>;
}
