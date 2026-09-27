import type { DeliveryStatus, ReviewLogEntry, StructuredLogSink } from "../presentation/types";
import type { LocalReviewHistory } from "./types";

/**
 * Decorator over a `StructuredLogSink` that mirrors every entry to the local review
 * history. The host write and the history append start together and each failure is
 * contained, so neither sink can prevent the other or reach the review path. The
 * returned delivery status is the host sink's, preserving the presenter contract.
 */
export function createMirroredReviewLogSink(
  hostSink: StructuredLogSink,
  history: Pick<LocalReviewHistory, "append">,
): StructuredLogSink {
  return {
    async write(entry: ReviewLogEntry): Promise<DeliveryStatus> {
      const [hostStatus] = await Promise.all([
        writeHost(hostSink, entry),
        appendHistory(history, entry),
      ]);

      return hostStatus;
    },
  };
}

async function writeHost(sink: StructuredLogSink, entry: ReviewLogEntry): Promise<DeliveryStatus> {
  try {
    return await sink.write(entry);
  } catch {
    return "FAILED";
  }
}

async function appendHistory(
  history: Pick<LocalReviewHistory, "append">,
  entry: ReviewLogEntry,
): Promise<void> {
  try {
    await history.append(entry);
  } catch {
    return;
  }
}
