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

export type ProposalWriteResult = "WRITTEN" | "FAILED";

/** Private store of proposal requests under the user's data home; never throws. */
export interface WorkerProposalStore {
  write(handoff: ClaudeReviewHandoff, file: ProposalRequestFile): ProposalWriteResult;
  /** Deletes the request of a unit whose feed record was not written. */
  remove(handoff: ClaudeReviewHandoff): void;
  /** Removes blank and expired requests. */
  sweep(): void;
}
