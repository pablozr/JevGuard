import type {
  DeliveryStatus,
  OpenCodePresentationClient,
  ProposalSessionNavigator,
  RemediationNotifier,
  ToastSink,
} from "./types";

const TITLE = "JevGuard";
const PREPARING_MESSAGE = "JevGuard is preparing a remediation proposal in the child session.";
const READY_MESSAGE = "JevGuard remediation proposal ready.";

/**
 * Builds the safe, generic remediation notifier over the transient toast sink. Both
 * messages are fixed templates with no rule, task, diff, finding, or credential
 * content, and every delivery failure is contained as `FAILED`.
 */
export function createRemediationNotifier(toast: ToastSink): RemediationNotifier {
  return {
    async proposalPreparing(): Promise<DeliveryStatus> {
      return showRemediationToast(toast, PREPARING_MESSAGE);
    },

    async proposalReady(): Promise<DeliveryStatus> {
      return showRemediationToast(toast, READY_MESSAGE);
    },
  };
}

async function showRemediationToast(toast: ToastSink, message: string): Promise<DeliveryStatus> {
  try {
    return await toast.show({ title: TITLE, message, variant: "info" });
  } catch {
    return "FAILED";
  }
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
