import type { TurnReview } from "@jevguard/core";
import {
  type DeliveryStatus,
  type ReviewLogEntry,
  type StructuredLogSink,
  toReviewLogEntry,
} from "@jevguard/node-infra";
import { toReviewToast } from "./toast";
import type {
  PresentationDelivery,
  PresentationPorts,
  ReviewPresenter,
  ReviewToast,
  ToastSink,
} from "./types";

export { displayOutcome } from "./display";
export { logLevelFor, reviewLogMessage } from "./log";
export {
  createOpenCodeLogSink,
  createOpenCodePresentationClient,
  createOpenCodeToastSink,
} from "./opencode";
export {
  createOpenCodeSessionNavigator,
  createRemediationFailureLogSink,
  createRemediationNotifier,
} from "./remediation";
export { countSummary, toReviewToast, toastVariantFor } from "./toast";
export type {
  OpenCodeLogInput,
  OpenCodeLogResult,
  OpenCodePresentationClient,
  OpenCodeSessionSelectInput,
  OpenCodeSessionSelectResult,
  OpenCodeToastInput,
  OpenCodeToastResult,
  PresentationDelivery,
  PresentationPorts,
  ProposalFailureReason,
  ProposalSessionNavigator,
  RemediationFailureLogSink,
  RemediationNotifier,
  ReviewPresenter,
  ReviewToast,
  ToastSink,
  ToastVariant,
} from "./types";

/**
 * Delivers one aggregate turn review to both sinks. Log is attempted before
 * toast, and each delivery is isolated so a log or toast failure never prevents
 * the other and never propagates to the caller.
 */
export function createReviewPresenter(ports: PresentationPorts): ReviewPresenter {
  return {
    async present(review: TurnReview): Promise<PresentationDelivery> {
      const log = await deliverLog(ports.log, toReviewLogEntry(review));
      const toast = await deliverToast(ports.toast, toReviewToast(review));

      return { log, toast };
    },
  };
}

async function deliverLog(sink: StructuredLogSink, entry: ReviewLogEntry): Promise<DeliveryStatus> {
  try {
    return await sink.write(entry);
  } catch {
    return "FAILED";
  }
}

async function deliverToast(sink: ToastSink, toast: ReviewToast): Promise<DeliveryStatus> {
  try {
    return await sink.show(toast);
  } catch {
    return "FAILED";
  }
}
