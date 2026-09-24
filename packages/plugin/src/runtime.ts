import { attributeTurn } from "@jevguard/opencode-adapter";
import { idleSessionID } from "./idle-event";
import { presentReview } from "./present";
import { reviewAttributedTurn } from "./review";
import { unavailableReview } from "./review-result";
import type { PluginEventInput, PluginRuntime, PluginRuntimeDependencies } from "./types";

/**
 * Builds the plugin runtime for one initialization. The event hook resolves
 * immediately after scheduling: attribution and the dedupe mark stay serialized in
 * one FIFO queue, while the attributed review runs detached so policy, Jev,
 * presentation, and any automatic proposal never sit on the agent's critical path.
 * A session created by this plugin's own proposal is excluded before attribution, so
 * the child session's idle events can never be reviewed or propose again. `drain`
 * awaits all detached work and is the test-only handle the host never receives. There
 * is no command hook and no prompt, message mutation, or apply path.
 */
export function createPluginRuntime(dependencies: PluginRuntimeDependencies): PluginRuntime {
  let attributionTail: Promise<void> = Promise.resolve();
  const backgroundJobs = new Set<Promise<void>>();

  function track(work: Promise<void>): void {
    const contained = work.then(ignore, ignore);

    backgroundJobs.add(contained);
    void contained.then(() => {
      backgroundJobs.delete(contained);
    });
  }

  function enqueueAttribution(sessionID: string): void {
    const run = attributionTail.then(() => processIdle(sessionID));

    attributionTail = run.then(ignore, ignore);
  }

  async function processIdle(sessionID: string): Promise<void> {
    try {
      if (dependencies.proposals.isChildSession(sessionID)) {
        return;
      }

      const attribution = await attributeTurn(sessionID, {
        facade: dependencies.facade,
        deduplicator: dependencies.deduplicator,
      });

      switch (attribution.status) {
        case "NONE":
        case "ALREADY_PROCESSED":
          return;
        case "UNAVAILABLE":
          track(
            presentReview(
              dependencies.presenter,
              unavailableReview(sessionID, "MISSING_ATTRIBUTED_DIFF"),
            ),
          );
          return;
        case "ATTRIBUTED":
          track(reviewAttributedTurn(attribution.turn, sessionID, dependencies));
          return;
      }
    } catch {
      return;
    }
  }

  async function drain(): Promise<void> {
    while (true) {
      await attributionTail;

      if (backgroundJobs.size === 0) {
        return;
      }

      await Promise.all([...backgroundJobs]);
    }
  }

  return {
    hooks: {
      event: (input: PluginEventInput): Promise<void> => {
        const sessionID = idleSessionID(input.event);

        if (sessionID === null) {
          return Promise.resolve();
        }

        enqueueAttribution(sessionID);

        return Promise.resolve();
      },
    },
    drain,
  };
}

function ignore(): void {
  return;
}
