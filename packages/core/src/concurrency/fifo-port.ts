import type { JevEvaluationPort, JevEvaluationResult, JevRequest } from "../ports/types";
import type { FifoJevPortConfig } from "./types";

interface PendingEvaluation {
  readonly request: JevRequest;
  readonly settle: (result: JevEvaluationResult) => void;
  readonly fail: (error: unknown) => void;
}

/**
 * Wraps a Jev port with one shared FIFO concurrency limit: every `evaluate` call
 * across all rules, built-ins, and turns enters the same queue, and at most
 * `maxConcurrency` underlying evaluations are in flight. Queued calls start in
 * submission order as slots free. The wrapper preserves the underlying result or
 * rejection exactly and adds no retry, timeout, priority, or cancellation.
 */
export function createFifoJevPort(
  port: JevEvaluationPort,
  config: FifoJevPortConfig,
): JevEvaluationPort {
  const maxConcurrency = config.maxConcurrency;

  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError("maxConcurrency must be a positive integer");
  }

  const queue: PendingEvaluation[] = [];
  let active = 0;

  function drain(): void {
    while (active < maxConcurrency && queue.length > 0) {
      const pending = queue.shift();

      if (pending === undefined) {
        return;
      }

      active += 1;
      start(pending);
    }
  }

  function start(pending: PendingEvaluation): void {
    Promise.resolve()
      .then(() => port.evaluate(pending.request))
      .then(
        (result) => {
          active -= 1;
          pending.settle(result);
          drain();
        },
        (error: unknown) => {
          active -= 1;
          pending.fail(error);
          drain();
        },
      );
  }

  return {
    evaluate(request: JevRequest): Promise<JevEvaluationResult> {
      return new Promise<JevEvaluationResult>((settle, fail) => {
        queue.push({ request, settle, fail });
        drain();
      });
    },
  };
}
