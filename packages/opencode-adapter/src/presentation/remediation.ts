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
 * execution that is never reviewed, one line with the typed reason for an attribution
 * failure, and one line per remediation delivery or config event. Only ids, counts and
 * typed codes are attached.
 */
export function createOperationalLogSink(writer: OpenCodeLogWriter): OperationalLogSink {
  return {
    write(event: OperationalEvent): Promise<DeliveryStatus> {
      const { kind, ...extra } = event;

      return writeLogRecord(writer, {
        service: SERVICE_NAME,
        level: levelOf(event),
        message: operationalMessage(event),
        extra,
      });
    },
  };
}

function levelOf(event: OperationalEvent): "info" | "warn" {
  return event.kind === "ATTRIBUTION_UNAVAILABLE" ||
    event.kind === "REVIEW_INTERRUPTED" ||
    event.kind === "REMEDIATION_NOT_SENT" ||
    event.kind === "REMEDIATION_CONFIG_LEGACY" ||
    event.kind === "REMEDIATION_CONFIG_INVALID"
    ? "warn"
    : "info";
}

function operationalMessage(event: OperationalEvent): string {
  switch (event.kind) {
    case "TURN_SKIPPED":
      return `JevGuard skipped · ${event.reason}`;
    case "REVIEW_INTERRUPTED":
      return "JevGuard review interrupted · the host shut down before the review finished";
    case "ATTRIBUTION_UNAVAILABLE":
      return ATTRIBUTION_LOG_MESSAGE;
    case "REMEDIATION_SENT":
      return `JevGuard sent the remediation to the agent · ${event.strategy}`;
    case "REMEDIATION_NOT_SENT":
      return `JevGuard remediation not sent · ${event.code}${event.cause === undefined ? "" : ` · ${event.cause}`}`;
    case "REMEDIATION_CONFIG_LEGACY":
      return "JevGuard remediation: mode/max_attempts in your opencode.yaml are no longer used · see docs/configuration.md";
    case "REMEDIATION_CONFIG_INVALID":
      return `JevGuard remediation is off · your opencode.yaml is not valid (${event.reason}) · see docs/configuration.md`;
  }
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
