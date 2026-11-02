import type { JevEvaluationPort, PolicyLoader } from "@jevguard/core";
import type { OperationalLogSink, ReviewPresenter, TurnTracker } from "@jevguard/opencode-adapter";
import type { ProposalDependencies } from "./remediation/propose";

export interface ReviewDependencies extends ProposalDependencies {
  readonly policy: PolicyLoader;
  readonly presenter: ReviewPresenter;
  readonly jev: JevEvaluationPort;
}

export interface PluginRuntimeDependencies extends ReviewDependencies {
  readonly tracker: TurnTracker;
  readonly operational: OperationalLogSink;
}

/**
 * Internal runtime handle. `onEvent` takes one raw host event and returns at once;
 * `drain` awaits the queued and detached work, for shutdown and tests.
 */
export interface PluginRuntime {
  onEvent(event: unknown): void;
  drain(): Promise<void>;
}
