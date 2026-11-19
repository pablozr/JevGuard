import { unavailableReview } from "@jevguard/core";
import type {
  OperationalEvent,
  OperationalLogSink,
  PresentationDelivery,
  ReviewPresenter,
} from "../index";
import { presentReview } from "./present";
import { createSessionIdleWaiter } from "./remediation/idle-waiter";
import { reviewAttributedTurn } from "./review";
import { parseTurnEvent } from "./turn-event";
import type { PluginRuntime, PluginRuntimeDependencies, ReviewDependencies } from "./types";

/**
 * Delivery reported to a caller that is no longer there. A unit closed by `abandon`
 * has already been presented as `REVIEW_INTERRUPTED`; a verdict that arrives after
 * that is dropped so the unit never carries two lines, and this value is never
 * observed (presentation discards it).
 */
const DROPPED_DELIVERY: PresentationDelivery = { log: "DELIVERED", toast: "DELIVERED" };

/**
 * Builds the plugin runtime for one setup. Each lifecycle event is handled at once:
 * snapshot capture, attribution, and discard stay serialized in one FIFO queue in
 * event order, while the attributed review runs detached so policy, Jev,
 * presentation, and any automatic proposal never sit on the agent's critical path.
 *
 * - `started` stamps the arrival generation synchronously, then captures the start
 *   snapshot in the queue.
 * - `succeeded` attributes the execution: an attributed turn is reviewed; an
 *   unavailable one is presented as `MISSING_ATTRIBUTED_DIFF` and its typed reason is
 *   logged.
 * - `interrupted`/`failed` drop the snapshot and log `JevGuard skipped · <reason>`
 *   (nested host subagents stay silent).
 * - A proposer child session is never reviewed; its terminal events settle the
 *   proposal waiting on it.
 * - The sessions with an execution in progress are tracked so a delivery waits for idle
 *   instead of landing in a busy session.
 *
 * Only `delivery: agent` sends anything into the originating session (at most one queued
 * synthetic message per reviewed unit); nothing is ever applied.
 */
export function createPluginRuntime(dependencies: PluginRuntimeDependencies): PluginRuntime {
  const { tracker } = dependencies;
  const openExecutions = new Set<string>();
  const idle = createSessionIdleWaiter((sessionID) => openExecutions.has(sessionID));
  const reviewDependencies = { ...dependencies, idle };
  let tail: Promise<void> = Promise.resolve();
  const backgroundJobs = new Set<Promise<void>>();
  /** Units whose attribution or review still runs: a shutdown that cuts them owes a line each. */
  const activeUnits = new Set<string>();
  /** Units the shutdown already closed as `REVIEW_INTERRUPTED`: a late verdict is dropped. */
  const interrupted = new Set<string>();

  function presenterFor(sessionID: string): ReviewPresenter {
    return {
      present(review) {
        if (interrupted.has(sessionID)) {
          return Promise.resolve(DROPPED_DELIVERY);
        }

        return dependencies.presenter.present(review);
      },
    };
  }

  function track(work: Promise<void>): void {
    const contained = work.then(ignore, ignore);

    backgroundJobs.add(contained);
    void contained.then(() => {
      backgroundJobs.delete(contained);
    });
  }

  function enqueue(work: () => Promise<void>): void {
    tail = tail.then(work).then(ignore, ignore);
  }

  function log(event: OperationalEvent): void {
    track(writeOperational(dependencies.operational, event));
  }

  /** Returns whether a detached review job now owns the unit. */
  async function finish(sessionID: string): Promise<boolean> {
    const attribution = await tracker.finish(sessionID);

    switch (attribution.status) {
      case "NONE":
      case "ALREADY_PROCESSED":
        return false;
      case "UNAVAILABLE":
        log({ kind: "ATTRIBUTION_UNAVAILABLE", reason: attribution.reason });
        track(
          presentReview(
            dependencies.presenter,
            unavailableReview(sessionID, "MISSING_ATTRIBUTED_DIFF"),
          ),
        );
        return false;
      case "ATTRIBUTED": {
        const unitDependencies: ReviewDependencies = {
          ...reviewDependencies,
          presenter: presenterFor(sessionID),
        };

        track(
          reviewAttributedTurn(
            attribution.turn,
            sessionID,
            attribution.delivery,
            unitDependencies,
          ).finally(() => activeUnits.delete(sessionID)),
        );
        return true;
      }
    }
  }

  return {
    onEvent(event) {
      const turn = parseTurnEvent(event);

      if (turn === null) {
        return;
      }

      const { sessionID } = turn;

      if (dependencies.proposals.isChildSession(sessionID)) {
        if (turn.kind !== "STARTED") {
          dependencies.childExecutions.settle(
            sessionID,
            turn.kind === "SUCCEEDED" ? "SUCCEEDED" : "ENDED",
          );
        }

        return;
      }

      switch (turn.kind) {
        case "STARTED": {
          openExecutions.add(sessionID);

          const generation = tracker.noteStarted(sessionID);

          enqueue(() => tracker.start(sessionID, generation));
          return;
        }
        case "SUCCEEDED":
          openExecutions.delete(sessionID);
          idle.notifyIdle(sessionID);
          // Active from the event itself: a shutdown may cut the unit before its turn
          // in the queue comes.
          activeUnits.add(sessionID);
          enqueue(async () => {
            if (!(await finish(sessionID))) {
              activeUnits.delete(sessionID);
            }
          });
          return;
        case "ENDED_OTHER":
          openExecutions.delete(sessionID);
          idle.notifyIdle(sessionID);
          enqueue(async () => {
            if (!tracker.discard(sessionID).nested) {
              log({ kind: "TURN_SKIPPED", reason: turn.reason });
            }
          });
          return;
      }
    },

    async drain() {
      while (true) {
        await tail;

        if (backgroundJobs.size === 0) {
          return;
        }

        await Promise.all([...backgroundJobs]);
      }
    },

    async abandon() {
      const units = [...activeUnits].filter((sessionID) => !interrupted.has(sessionID));

      for (const sessionID of units) {
        interrupted.add(sessionID);
      }

      activeUnits.clear();

      await Promise.all(
        units.map((sessionID) =>
          presentReview(dependencies.presenter, unavailableReview(sessionID, "REVIEW_INTERRUPTED")),
        ),
      );
    },
  };
}

async function writeOperational(sink: OperationalLogSink, event: OperationalEvent): Promise<void> {
  await sink.write(event);
}

function ignore(): void {
  return;
}
