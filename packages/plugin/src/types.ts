import type { JevEvaluationPort, PolicyLoader } from "@jevguard/core";
import type { OperationalLogSink, ReviewPresenter, TurnTracker } from "@jevguard/opencode-adapter";
import type { ProposalDependencies } from "./remediation/propose";
import type { RemediateSetup, SessionIdleWaiter } from "./remediation/types";

export interface ReviewDependencies extends ProposalDependencies {
  readonly policy: PolicyLoader;
  readonly presenter: ReviewPresenter;
  readonly jev: JevEvaluationPort;
  readonly operational: OperationalLogSink;
  /** Present only when the user's file opted into `delivery: agent`; otherwise reviews observe. */
  readonly remediation: RemediateSetup | null;
  /** Resolves when the session has no execution in progress. */
  readonly idle: SessionIdleWaiter;
}

export interface PluginRuntimeDependencies extends Omit<ReviewDependencies, "idle"> {
  readonly tracker: TurnTracker;
}

/**
 * Internal runtime handle. `onEvent` takes one raw host event and returns at once;
 * `drain` awaits the queued and detached work, for shutdown and tests.
 */
export interface PluginRuntime {
  onEvent(event: unknown): void;
  drain(): Promise<void>;
}
