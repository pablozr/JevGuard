import type { JevEvaluationPort, RemediationProposalStore } from "@jevguard/core";
import type {
  OpenCodeSessionFacade,
  PolicyLoader,
  ProposalSessionFacade,
  ProposalSessionNavigator,
  RemediationNotifier,
  ReviewPresenter,
  TurnDeduplicator,
} from "@jevguard/opencode-adapter";

export interface PluginEventInput {
  readonly event: unknown;
}

/**
 * The host hook surface this plugin returns. Only the event payload is observed;
 * malformed input is ignored internally, so the object remains assignable to the
 * typed `Hooks` surface. There is no command hook: remediation is automatic and never
 * rewrites host output.
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
  readonly proposals: RemediationProposalStore;
  readonly proposalFacade: ProposalSessionFacade;
  readonly navigator: ProposalSessionNavigator;
  readonly notifier: RemediationNotifier;
}

export interface PluginRuntimeDependencies extends ReviewDependencies {
  readonly facade: OpenCodeSessionFacade;
  readonly deduplicator: TurnDeduplicator;
}
