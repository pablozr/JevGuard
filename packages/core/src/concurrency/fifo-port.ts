import type {
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleEvaluationResult,
  JevRuleRequest,
} from "../ports/types";
import type { FifoJevPortConfig } from "./types";

interface PendingSingleEvaluation {
  readonly kind: "SINGLE";
  readonly request: JevRequest;
  readonly settle: (result: JevEvaluationResult) => void;
  readonly fail: (error: unknown) => void;
}

interface PendingRuleBatchEvaluation {
  readonly kind: "BATCH";
  readonly requests: readonly JevRuleRequest[];
  readonly settle: (results: readonly JevRuleEvaluationResult[]) => void;
  readonly fail: (error: unknown) => void;
}

type PendingEvaluation = PendingSingleEvaluation | PendingRuleBatchEvaluation;

/**
 * Wraps a Jev port with one shared FIFO concurrency limit: every `evaluate` call and
 * every `evaluateRuleBatch` call across all rules, built-ins, and turns enters the same
 * queue, and at most `maxConcurrency` underlying entries are in flight. A rule batch
 * occupies one queue slot while the adapter owns the bounded concurrency of its slices.
 * Queued calls start in submission order as slots free. The wrapper preserves the
 * underlying result or rejection exactly and adds no retry, timeout, priority, or
 * cancellation.
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
    if (pending.kind === "BATCH") {
      Promise.resolve()
        .then(() => port.evaluateRuleBatch(pending.requests))
        .then(
          (results) => {
            active -= 1;
            pending.settle(results);
            drain();
          },
          (error: unknown) => {
            active -= 1;
            pending.fail(error);
            drain();
          },
        );

      return;
    }

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
        queue.push({ kind: "SINGLE", request, settle, fail });
        drain();
      });
    },
    evaluateRuleBatch(
      requests: readonly JevRuleRequest[],
    ): Promise<readonly JevRuleEvaluationResult[]> {
      return new Promise<readonly JevRuleEvaluationResult[]>((settle, fail) => {
        queue.push({ kind: "BATCH", requests, settle, fail });
        drain();
      });
    },
  };
}
