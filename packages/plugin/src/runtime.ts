import { unavailableReview } from "@jevguard/core";
import type { OperationalEvent, OperationalLogSink } from "@jevguard/opencode-adapter";
import { presentReview } from "./present";
import { endOrphanChain } from "./remediation/remediate";
import { reviewAttributedTurn } from "./review";
import { parseTurnEvent } from "./turn-event";
import type { PluginRuntime, PluginRuntimeDependencies } from "./types";

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
 * - In `remediate`, the sessions with an execution in progress are tracked so nothing is
 *   queued into a busy session, and an execution with no reviewable turn ends its
 *   session's chain as unverified.
 *
 * Only `remediate` sends anything into the originating session (one queued synthetic
 * message per attempt); nothing is ever applied.
 */
export function createPluginRuntime(dependencies: PluginRuntimeDependencies): PluginRuntime {
  const { tracker } = dependencies;
  const openExecutions = new Set<string>();
  const reviewDependencies = {
    ...dependencies,
    isBusy: (sessionID: string) => openExecutions.has(sessionID),
  };
  let tail: Promise<void> = Promise.resolve();
  const backgroundJobs = new Set<Promise<void>>();

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

  function endOrphan(sessionID: string): void {
    const { remediation } = dependencies;

    if (remediation !== null) {
      track(endOrphanChain(sessionID, { remediation, operational: dependencies.operational }));
    }
  }

  async function finish(sessionID: string): Promise<void> {
    const attribution = await tracker.finish(sessionID);

    switch (attribution.status) {
      case "NONE":
      case "ALREADY_PROCESSED":
        return;
      case "UNAVAILABLE":
        log({ kind: "ATTRIBUTION_UNAVAILABLE", reason: attribution.reason });
        endOrphan(sessionID);
        track(
          presentReview(
            dependencies.presenter,
            unavailableReview(sessionID, "MISSING_ATTRIBUTED_DIFF"),
          ),
        );
        return;
      case "ATTRIBUTED":
        track(
          reviewAttributedTurn(
            attribution.turn,
            sessionID,
            attribution.delivery,
            reviewDependencies,
          ),
        );
        return;
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
          enqueue(() => finish(sessionID));
          return;
        case "ENDED_OTHER":
          openExecutions.delete(sessionID);
          enqueue(async () => {
            if (!tracker.discard(sessionID).nested) {
              log({ kind: "TURN_SKIPPED", reason: turn.reason });
              endOrphan(sessionID);
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
  };
}

async function writeOperational(sink: OperationalLogSink, event: OperationalEvent): Promise<void> {
  await sink.write(event);
}

function ignore(): void {
  return;
}
