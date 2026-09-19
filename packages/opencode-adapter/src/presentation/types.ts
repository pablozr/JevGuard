import type {
  OperationalStatus,
  ReviewResult,
  RuleSeverity,
  SemanticVerdict,
  SkippedReason,
  UnavailableReason,
} from "@jevguard/core";

export type ToastVariant = "info" | "success" | "warning" | "error";

export type DeliveryStatus = "DELIVERED" | "FAILED";

interface ReviewLogContext {
  readonly turnId: string;
  readonly ruleId: string | null;
  readonly severity: RuleSeverity | null;
  readonly scopedPaths: readonly string[];
}

/**
 * Exact structured-log allowlist. Semantic outcomes carry the raw probability;
 * operational outcomes carry the typed reason. Nothing else may be logged.
 */
export type ReviewLogEntry =
  | (ReviewLogContext & {
      readonly outcome: SemanticVerdict;
      readonly violationProbability: number;
    })
  | (ReviewLogContext & {
      readonly outcome: OperationalStatus;
      readonly reason: SkippedReason | UnavailableReason;
    });

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
  present(result: ReviewResult): Promise<PresentationDelivery>;
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

/**
 * Narrow OpenCode client surface for presentation. Structural typing keeps the
 * adapter decoupled from the SDK runtime and lets tests fake log/toast delivery.
 */
export interface OpenCodePresentationClient {
  readonly app: {
    log(input: OpenCodeLogInput): Promise<OpenCodeLogResult>;
  };
  readonly tui: {
    showToast(input: OpenCodeToastInput): Promise<OpenCodeToastResult>;
  };
}
