import type { JevEvaluationPort, PolicyLoader } from "@jevguard/core";
import type { OperationalLogSink, ReviewPresenter, TurnTracker } from "../index";
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
  /**
   * Stops waiting for detached work: every unit still in flight is presented once as
   * `UNAVAILABLE/REVIEW_INTERRUPTED`, and a verdict that arrives afterwards is dropped
   * so a unit never carries two lines. Used when the host shuts down mid-review.
   */
  abandon(): Promise<void>;
}
