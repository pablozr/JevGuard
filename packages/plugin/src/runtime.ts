import { attributeTurn } from "@jevguard/opencode-adapter";
import { idleSessionID } from "./idle-event";
import { presentResult } from "./present";
import { reviewAttributedTurn } from "./review";
import { unavailableResult } from "./review-result";
import type { PluginEventInput, PluginHooks, PluginRuntimeDependencies } from "./types";

/**
 * Builds the plugin hooks for one initialization. Idle handling is serialized
 * through a promise queue so the attribution check and mark never overlap, and
 * every host-visible failure is contained so the event hook always resolves.
 */
export function createPluginRuntime(dependencies: PluginRuntimeDependencies): PluginHooks {
  let tail: Promise<void> = Promise.resolve();

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = tail.then(task, task);

    tail = run.then(ignore, ignore);

    return tail;
  }

  return {
    event: async (input: PluginEventInput): Promise<void> => {
      const sessionID = idleSessionID(input.event);

      if (sessionID === null) {
        return;
      }

      await enqueue(() => processIdle(sessionID, dependencies));
    },
  };
}

async function processIdle(
  sessionID: string,
  dependencies: PluginRuntimeDependencies,
): Promise<void> {
  try {
    const attribution = await attributeTurn(sessionID, {
      facade: dependencies.facade,
      deduplicator: dependencies.deduplicator,
    });

    switch (attribution.status) {
      case "NONE":
      case "ALREADY_PROCESSED":
        return;
      case "UNAVAILABLE":
        await presentResult(
          dependencies.presenter,
          unavailableResult(sessionID, null, "MISSING_ATTRIBUTED_DIFF"),
        );
        return;
      case "ATTRIBUTED":
        await reviewAttributedTurn(attribution.turn, dependencies);
        return;
    }
  } catch {
    return;
  }
}

function ignore(): void {
  return;
}
