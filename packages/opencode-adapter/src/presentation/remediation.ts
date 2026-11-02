import type { DeliveryStatus } from "@jevguard/node-infra";
import { SERVICE_NAME, writeLogRecord } from "./opencode";
import type {
  OpenCodeLogWriter,
  OperationalEvent,
  OperationalLogSink,
  ProposalFailureReason,
  ProposalSessionNavigator,
  RemediationFailureLogSink,
  RemediationNotifier,
  ToastSink,
} from "./types";

const TITLE = "JevGuard";
const PREPARING_MESSAGE = "JevGuard is preparing a remediation proposal in the child session.";
const READY_MESSAGE = "JevGuard remediation proposal ready.";
const FAILED_MESSAGE = "JevGuard could not prepare a remediation proposal.";
const FAILURE_LOG_MESSAGE = "JevGuard remediation proposal failed";
const ATTRIBUTION_LOG_MESSAGE = "JevGuard attribution unavailable";

/**
 * Builds the safe, generic remediation notifier over the transient toast sink. All
 * messages are fixed templates with no rule, task, diff, finding, or credential
 * content, and every delivery failure is contained as `FAILED`.
 */
export function createRemediationNotifier(toast: ToastSink): RemediationNotifier {
  return {
    async proposalPreparing(): Promise<DeliveryStatus> {
      return showRemediationToast(toast, PREPARING_MESSAGE, "info");
    },

    async proposalReady(): Promise<DeliveryStatus> {
      return showRemediationToast(toast, READY_MESSAGE, "info");
    },

    async proposalFailed(): Promise<DeliveryStatus> {
      return showRemediationToast(toast, FAILED_MESSAGE, "error");
    },
  };
}

async function showRemediationToast(
  toast: ToastSink,
  message: string,
  variant: "info" | "error",
): Promise<DeliveryStatus> {
  try {
    return await toast.show({ title: TITLE, message, variant });
  } catch {
    return "FAILED";
  }
}

/**
 * Builds the safe failure-log sink. It writes one error record with a fixed message
 * and an `extra` payload containing only the typed `reason`; no task, diff, rule,
 * finding, path, or credential is attached. Every delivery failure is `FAILED`.
 */
export function createRemediationFailureLogSink(
  writer: OpenCodeLogWriter,
): RemediationFailureLogSink {
  return {
    write(reason: ProposalFailureReason): Promise<DeliveryStatus> {
      return writeLogRecord(writer, {
        service: SERVICE_NAME,
        level: "error",
        message: FAILURE_LOG_MESSAGE,
        extra: { reason },
      });
    },
  };
}

/**
 * Builds the operational log sink: `JevGuard skipped · interrupted|failed` for an
 * execution that is never reviewed, and one line with the typed reason for an
 * attribution failure. Only the typed code is attached.
 */
export function createOperationalLogSink(writer: OpenCodeLogWriter): OperationalLogSink {
  return {
    write(event: OperationalEvent): Promise<DeliveryStatus> {
      const skipped = event.kind === "TURN_SKIPPED";

      return writeLogRecord(writer, {
        service: SERVICE_NAME,
        level: skipped ? "info" : "warn",
        message: skipped ? `JevGuard skipped · ${event.reason}` : ATTRIBUTION_LOG_MESSAGE,
        extra: { reason: event.reason },
      });
    },
  };
}

/**
 * Navigator for the 2.2.x server plugin: a no-op that reports `DELIVERED`. The server
 * plugin context has no TUI routing; navigation returns with the `./tui` phase.
 */
export function createNullSessionNavigator(): ProposalSessionNavigator {
  return {
    navigate: async (): Promise<DeliveryStatus> => "DELIVERED",
  };
}
