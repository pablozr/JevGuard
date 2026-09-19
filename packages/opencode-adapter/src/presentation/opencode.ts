import type { OpencodeClient } from "@opencode-ai/sdk";
import { logLevelFor, reviewLogMessage } from "./log";
import type {
  DeliveryStatus,
  OpenCodePresentationClient,
  ReviewLogEntry,
  ReviewToast,
  StructuredLogSink,
  ToastSink,
} from "./types";

const SERVICE_NAME = "jevguard";
const TOAST_DURATION_MS = 5000;

/**
 * Adapts the concrete OpenCode client to the narrow presentation surface. Typing
 * the parameter as the SDK client keeps compilation pinned to the supported
 * OpenCode SDK version.
 */
export function createOpenCodePresentationClient(
  client: OpencodeClient,
): OpenCodePresentationClient {
  return {
    app: {
      log: (input) => client.app.log({ body: input.body }),
    },
    tui: {
      showToast: (input) => client.tui.showToast({ body: input.body }),
    },
  };
}

/**
 * OpenCode structured-log sink. Only the allowlisted entry fields are sent as
 * `extra`; the SDK's non-throwing result is still checked and every rejection is
 * swallowed into a typed status.
 */
export function createOpenCodeLogSink(client: OpenCodePresentationClient): StructuredLogSink {
  return {
    async write(entry: ReviewLogEntry): Promise<DeliveryStatus> {
      try {
        const result = await client.app.log({
          body: {
            service: SERVICE_NAME,
            level: logLevelFor(entry.outcome),
            message: reviewLogMessage(entry),
            extra: toLogExtra(entry),
          },
        });

        return result.error === undefined ? "DELIVERED" : "FAILED";
      } catch {
        return "FAILED";
      }
    },
  };
}

/** OpenCode transient-toast sink; never adds a session message or prompt. */
export function createOpenCodeToastSink(client: OpenCodePresentationClient): ToastSink {
  return {
    async show(toast: ReviewToast): Promise<DeliveryStatus> {
      try {
        const result = await client.tui.showToast({
          body: {
            title: toast.title,
            message: toast.message,
            variant: toast.variant,
            duration: TOAST_DURATION_MS,
          },
        });

        return result.error === undefined ? "DELIVERED" : "FAILED";
      } catch {
        return "FAILED";
      }
    },
  };
}

function toLogExtra(entry: ReviewLogEntry): Record<string, unknown> {
  const context = {
    turnId: entry.turnId,
    ruleId: entry.ruleId,
    severity: entry.severity,
    scopedPaths: [...entry.scopedPaths],
    outcome: entry.outcome,
  };

  switch (entry.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return { ...context, violationProbability: entry.violationProbability };
    case "SKIPPED":
    case "UNAVAILABLE":
      return { ...context, reason: entry.reason };
  }
}
