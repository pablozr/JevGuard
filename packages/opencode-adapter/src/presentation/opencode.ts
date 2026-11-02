import type {
  DeliveryStatus,
  ReviewLogEntry,
  ReviewLogResult,
  StructuredLogSink,
} from "@jevguard/node-infra";
import { displayOutcome } from "./display";
import { logLevelFor, reviewLogMessage } from "./log";
import type { OpenCodeLogRecord, OpenCodeLogWriter, ToastSink } from "./types";

export const SERVICE_NAME = "jevguard";

/**
 * Default log writer: one JSON line per record on standard error. `print` is
 * injectable for tests.
 */
export function createConsoleLogWriter(
  print: (line: string) => void = (line) => console.error(line),
): OpenCodeLogWriter {
  return {
    write(record: OpenCodeLogRecord): void {
      print(JSON.stringify(record));
    },
  };
}

/** Writes one record and maps any failure to `FAILED`; never throws. */
export async function writeLogRecord(
  writer: OpenCodeLogWriter,
  record: OpenCodeLogRecord,
): Promise<DeliveryStatus> {
  try {
    await writer.write(record);

    return "DELIVERED";
  } catch {
    return "FAILED";
  }
}

/**
 * Structured review-log sink. Only the allowlisted aggregate fields are sent as
 * `extra`; every failure is swallowed into a typed status.
 */
export function createOpenCodeLogSink(writer: OpenCodeLogWriter): StructuredLogSink {
  return {
    write(entry: ReviewLogEntry): Promise<DeliveryStatus> {
      return writeLogRecord(writer, {
        service: SERVICE_NAME,
        level: logLevelFor(displayOutcome(entry.summary.counts)),
        message: reviewLogMessage(entry),
        extra: toLogExtra(entry),
      });
    },
  };
}

/**
 * Toast sink for the 2.2.x server plugin, which has no TUI surface: a no-op that
 * reports `DELIVERED` until the `./tui` phase. It never adds a session message.
 */
export function createNullToastSink(): ToastSink {
  return {
    show: async (): Promise<DeliveryStatus> => "DELIVERED",
  };
}

function toLogExtra(entry: ReviewLogEntry): Record<string, unknown> {
  return {
    turnId: entry.turnId,
    summary: {
      highestVerdict: entry.summary.highestVerdict,
      hasUnavailable: entry.summary.hasUnavailable,
      counts: { ...entry.summary.counts },
    },
    results: entry.results.map(toResultExtra),
  };
}

function toResultExtra(result: ReviewLogResult): Record<string, unknown> {
  return { ...toIdentityExtra(result), ...toOutcomeExtra(result) };
}

function toIdentityExtra(result: ReviewLogResult): Record<string, unknown> {
  switch (result.kind) {
    case "RULE":
      return {
        kind: result.kind,
        ruleId: result.ruleId,
        severity: result.severity,
        scopedPaths: [...result.scopedPaths],
      };
    case "BUILT_IN":
      return {
        kind: result.kind,
        checkId: result.checkId,
        severity: result.severity,
        scopedPaths: [...result.scopedPaths],
      };
    case "REVIEW":
      return { kind: result.kind };
  }
}

function toOutcomeExtra(result: ReviewLogResult): Record<string, unknown> {
  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return { outcome: result.outcome, violationProbability: result.violationProbability };
    case "SKIPPED":
    case "UNAVAILABLE":
      return { outcome: result.outcome, reason: result.reason };
  }
}
