import type { JevEvaluationPort } from "@jevguard/core";
import type {
  OpenCodeSessionFacade,
  PolicyLoader,
  ReviewBridgePort,
  ReviewPresenter,
  TurnDeduplicator,
} from "@jevguard/opencode-adapter";

export interface PluginEventInput {
  readonly event: unknown;
}

/**
 * The host hook surface this plugin returns. The event payload stays `unknown`
 * internally so malformed events are ignored; it remains assignable to the typed
 * `Hooks` surface because it accepts every possible host event.
 */
export interface PluginHooks {
  event(input: PluginEventInput): Promise<void>;
}

/**
 * Internal runtime handle. `hooks` is the only surface the host receives; `drain`
 * lets tests await detached background work that the event hook deliberately does
 * not wait for.
 */
export interface PluginRuntime {
  readonly hooks: PluginHooks;
  readonly drain: () => Promise<void>;
}

export interface ReviewDependencies {
  readonly policy: PolicyLoader;
  readonly presenter: ReviewPresenter;
  readonly jev: JevEvaluationPort;
  readonly bridge: ReviewBridgePort;
}

export interface PluginRuntimeDependencies extends ReviewDependencies {
  readonly facade: OpenCodeSessionFacade;
  readonly deduplicator: TurnDeduplicator;
}
