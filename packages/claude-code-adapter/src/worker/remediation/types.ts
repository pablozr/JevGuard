import type { ChainClosure, ChainState } from "@jevguard/core";
import type {
  RemediationUserSettings,
  RemediationUserSettingsInvalidReason,
  RemediationUserSettingsResult,
} from "@jevguard/node-infra";
import type { ClaudeReviewHandoff } from "../../capture/types";
import type { ProposalRequestFile } from "../../presentation";

/** What the user's file turns on: where proposals go and which Claude model drafts them. */
export type ClaudeRemediationSettings = RemediationUserSettings;

export type ClaudeRemediationInvalidReason = RemediationUserSettingsInvalidReason;

export type ClaudeRemediationSettingsResult = RemediationUserSettingsResult;

export type {
  ProjectProbe,
  UserConfigEnvironment,
  UserConfigLoadInput,
  UserConfigParse,
} from "@jevguard/node-infra";

/** A private proposal request ready to be written, and whether its delivery was downgraded. */
export interface EncodedProposalRequest {
  readonly file: ProposalRequestFile;
  readonly downgraded: boolean;
}

export type ProposalWriteResult = "WRITTEN" | "FAILED";

export type { ChainClosure } from "@jevguard/core";

/** Private store of proposal requests under the user's data home; never throws. */
export interface WorkerProposalStore {
  write(handoff: ClaudeReviewHandoff, file: ProposalRequestFile): ProposalWriteResult;
  /** Deletes the request of a unit whose feed record was not written. */
  remove(handoff: ClaudeReviewHandoff): void;
  /** The saved state of a remediation chain, or `null` when absent, expired or unreadable. */
  loadChain(handoff: ClaudeReviewHandoff, chainId: string): ChainState | null;
  /** `true` only when the state is on disk, so a delivery never outlives its state. */
  saveChain(handoff: ClaudeReviewHandoff, state: ChainState): boolean;
  removeChain(handoff: ClaudeReviewHandoff, chainId: string): void;
  /** The newest saved chain of the unit's session, or `null` when there is none. */
  activeChain(handoff: ClaudeReviewHandoff): ChainState | null;
  /**
   * Removes blank and expired requests, then the chain states that ended outside a review:
   * those a delivery outcome names and those that expired. Returns each such chain once so
   * the worker can record how it ended.
   */
  sweep(): readonly ChainClosure[];
}
