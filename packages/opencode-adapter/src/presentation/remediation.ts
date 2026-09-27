import type {
  DeliveryStatus,
  OpenCodePresentationClient,
  ProposalFailureReason,
  ProposalSessionNavigator,
  RemediationFailureLogSink,
  RemediationNotifier,
  ToastSink,
} from "./types";

const TITLE = "JevGuard";
const SERVICE_NAME = "jevguard";
const PREPARING_MESSAGE = "JevGuard is preparing a remediation proposal in the child session.";
const READY_MESSAGE = "JevGuard remediation proposal ready.";
const FAILED_MESSAGE = "JevGuard could not prepare a remediation proposal.";
const FAILURE_LOG_MESSAGE = "JevGuard remediation proposal failed";

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
 * Builds the safe failure-log sink over the OpenCode `app.log` surface. It writes one
 * error entry with a fixed message and an `extra` payload containing only the typed
 * `reason`; no task, diff, rule, finding, path, or credential is attached. Every
 * delivery failure is contained as `FAILED`.
 */
export function createRemediationFailureLogSink(
  client: OpenCodePresentationClient,
): RemediationFailureLogSink {
  return {
    async write(reason: ProposalFailureReason): Promise<DeliveryStatus> {
      try {
        const result = await client.app.log({
          body: {
            service: SERVICE_NAME,
            level: "error",
            message: FAILURE_LOG_MESSAGE,
            extra: { reason },
          },
        });

        return result.error === undefined ? "DELIVERED" : "FAILED";
      } catch {
        return "FAILED";
      }
    },
  };
}

/**
 * Builds the safe TUI navigator over the OpenCode session-select surface. It sends
 * only the child session ID and every delivery failure is contained as `FAILED`.
 */
export function createOpenCodeSessionNavigator(
  client: OpenCodePresentationClient,
): ProposalSessionNavigator {
  return {
    async navigate(sessionID: string): Promise<DeliveryStatus> {
      try {
        const result = await client.tui.selectSession({ sessionID });

        return result.error === undefined ? "DELIVERED" : "FAILED";
      } catch {
        return "FAILED";
      }
    },
  };
}
