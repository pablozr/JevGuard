import type { ReviewResult } from "@jevguard/core";
import { toReviewLogEntry } from "./log";
import { toReviewToast } from "./toast";
import type {
  DeliveryStatus,
  PresentationDelivery,
  PresentationPorts,
  ReviewLogEntry,
  ReviewPresenter,
  ReviewToast,
  StructuredLogSink,
  ToastSink,
} from "./types";

export { formatRuleLabel, logLevelFor, reviewLogMessage, toReviewLogEntry } from "./log";
export {
  createOpenCodeLogSink,
  createOpenCodePresentationClient,
  createOpenCodeToastSink,
} from "./opencode";
export { toReviewToast } from "./toast";
export type {
  DeliveryStatus,
  OpenCodeLogInput,
  OpenCodeLogResult,
  OpenCodePresentationClient,
  OpenCodeToastInput,
  OpenCodeToastResult,
  PresentationDelivery,
  PresentationPorts,
  ReviewLogEntry,
  ReviewPresenter,
  ReviewToast,
  StructuredLogSink,
  ToastSink,
  ToastVariant,
} from "./types";

/**
 * Delivers one review result to both sinks. Each delivery is isolated so a log or
 * toast failure never prevents the other and never propagates to the caller.
 */
export function createReviewPresenter(ports: PresentationPorts): ReviewPresenter {
  return {
    async present(result: ReviewResult): Promise<PresentationDelivery> {
      const log = await deliverLog(ports.log, toReviewLogEntry(result));
      const toast = await deliverToast(ports.toast, toReviewToast(result));

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
