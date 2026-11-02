import type { ChainState, ChainStopCode, RemediationMode } from "@jevguard/core";
import type { ClaudeReviewHandoff } from "../../capture/types";
import type { ProposalDelivery, ProposalRequestFile } from "../../presentation";

/** What the user's file turns on: where proposals go and which Claude model drafts them. */
export interface ClaudeRemediationSettings {
  readonly delivery: ProposalDelivery;
  readonly model: string | null;
  /** `observe` (default) never messages the agent beyond one delivery; `remediate` runs a bounded chain. */
  readonly mode: RemediationMode;
  /** Deliveries one chain may make, 1..3; meaningful only in `remediate`. */
  readonly maxAttempts: number;
}

export type ClaudeRemediationInvalidReason =
  | "USER_CONFIG_INVALID"
  | "USER_CONFIG_IN_PROJECT"
  | "USER_CONFIG_UNREADABLE";

export type ClaudeRemediationSettingsResult =
  | { readonly status: "DISABLED" }
  | { readonly status: "ENABLED"; readonly settings: ClaudeRemediationSettings }
  | { readonly status: "INVALID"; readonly reason: ClaudeRemediationInvalidReason };

/** The process variables the user config location derives from; `undefined` when unset. */
export interface UserConfigEnvironment {
  readonly xdgConfigHome: string | undefined;
  readonly userProfile: string | undefined;
  readonly home: string | undefined;
}

export type UserConfigParse =
  | { readonly status: "PARSED"; readonly value: unknown }
  | { readonly status: "INVALID" };

/** The file-system questions that decide whether a path lies inside a project. */
export interface ProjectProbe {
  /** Canonical path, or `null` when the path does not exist; throws when it cannot be resolved. */
  readonly realPath: (path: string) => string | null;
  /** `true` when `directory` holds a `.git` file or directory. */
  readonly hasGitMarker: (directory: string) => boolean;
}

export interface UserConfigLoadInput extends ProjectProbe {
  readonly file: string;
  readonly projectRoot: string;
  /** File text, or `null` when the file does not exist; throws when it cannot be read. */
  readonly readText: (path: string) => string | null;
  readonly parse: (text: string) => UserConfigParse;
}

/** A private proposal request ready to be written, and whether its delivery was downgraded. */
export interface EncodedProposalRequest {
  readonly file: ProposalRequestFile;
  readonly downgraded: boolean;
}

export type ProposalWriteResult = "WRITTEN" | "FAILED";

/** A chain whose state was dropped without a review: why, and the state it ended with. */
export interface ChainClosure {
  readonly state: ChainState;
  readonly code: ChainStopCode;
}

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
