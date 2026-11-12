import type { IdleOutcome, SessionIdleWaiter } from "./types";

/**
 * Lets a delivery wait for the origin session to go idle. The waiter resolves at once for
 * an idle session; otherwise it resolves `IDLE` when the runtime reports the session's last
 * execution ended, or `TIMEOUT` after the budget (the timer never holds the process open).
 */
export function createSessionIdleWaiter(isBusy: (sessionID: string) => boolean): SessionIdleWaiter {
  const waiters = new Map<string, Set<(outcome: IdleOutcome) => void>>();

  return {
    untilIdle(sessionID, timeoutMs) {
      if (!isBusy(sessionID)) return Promise.resolve("IDLE");

      return new Promise((resolve) => {
        const timer = setTimeout(() => finish("TIMEOUT"), timeoutMs);

        timer.unref?.();

        function finish(outcome: IdleOutcome): void {
          clearTimeout(timer);
          waiters.get(sessionID)?.delete(finish);

          if (waiters.get(sessionID)?.size === 0) waiters.delete(sessionID);

          resolve(outcome);
        }

        const pending = waiters.get(sessionID) ?? new Set();

        pending.add(finish);
        waiters.set(sessionID, pending);
      });
    },

    notifyIdle(sessionID) {
      if (isBusy(sessionID)) return;

      for (const finish of [...(waiters.get(sessionID) ?? [])]) {
        finish("IDLE");
      }
    },
  };
}
