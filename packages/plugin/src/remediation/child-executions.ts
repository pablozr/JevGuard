/** How a proposer child execution ended, or that it outlived its time budget. */
export type ChildExecutionOutcome = "SUCCEEDED" | "ENDED" | "TIMEOUT";

/**
 * Correlates proposer child sessions with their execution lifecycle events. The
 * caller starts `wait` before prompting, so the child cannot run before a waiter
 * exists; a `settle` with no waiter (a late event after a timeout) is ignored.
 */
export interface ChildExecutionWatcher {
  wait(sessionID: string, timeoutMs: number): Promise<ChildExecutionOutcome>;
  settle(sessionID: string, outcome: Exclude<ChildExecutionOutcome, "TIMEOUT">): void;
}

export function createChildExecutionWatcher(): ChildExecutionWatcher {
  const waiters = new Map<string, (outcome: ChildExecutionOutcome) => void>();

  return {
    wait(sessionID, timeoutMs) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);

        timer.unref?.();

        function finish(outcome: ChildExecutionOutcome): void {
          clearTimeout(timer);
          waiters.delete(sessionID);
          resolve(outcome);
        }

        waiters.set(sessionID, finish);
      });
    },

    settle(sessionID, outcome) {
      waiters.get(sessionID)?.(outcome);
    },
  };
}
