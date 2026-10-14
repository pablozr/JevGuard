import type {
  JevEvaluationPort,
  PolicyConfigParser,
  PolicyLoader,
  RemediationProposalRequest,
  TurnReview,
} from "@jevguard/core";
import type { ReviewLogEntry } from "@jevguard/node-infra";
import type { ClaudeAcquisitionReason } from "../acquisition";
import type { ClaudeReviewHandoff } from "../capture/types";
import type {
  ClaudeRemediationInvalidReason,
  ClaudeRemediationSettingsResult,
  WorkerProposalStore,
} from "./remediation/types";

/** Synchronous file port over the handoff directory; tests substitute an in-memory fake. */
export interface WorkerFileSystem {
  /** Names directly inside `directory`; empty when it does not exist. */
  list(directory: string): readonly string[];
  /** File text, or `null` when the file does not exist. */
  read(path: string): string | null;
  /** Last modification time in epoch milliseconds, or `null` when the file is gone. */
  modifiedMs(path: string): number | null;
  /** Size in bytes, or `null` when the file is gone. */
  sizeBytes(path: string): number | null;
  /** Atomically moves a file; only `LOST` (source already gone) is an expected race. */
  rename(from: string, to: string): RenameResult;
  /** Deletes a file, retrying transient failures; throws when it cannot. */
  remove(path: string): void;
  ensureDirectory(path: string): void;
}

export type RenameResult = "MOVED" | "LOST" | "FAILED";

export type DeadlineResult<T> =
  | { readonly status: "DONE"; readonly value: T }
  | { readonly status: "DEADLINE" };

/** Bounds one review's wall-clock time; the late result is discarded. */
export interface ReviewDeadline {
  race<T>(work: Promise<T>, milliseconds: number): Promise<DeadlineResult<T>>;
}

/** Closed set of worker-log codes: no task, patch, path, finding, session id or credential. */
export type WorkerLogCode =
  | "WORKER_STARTED"
  | `REVIEW_RECORDED:${"PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE"}`
  | `UNIT_UNAVAILABLE:${ClaudeAcquisitionReason}`
  | "HANDOFF_INVALID"
  | "WORKER_CLAIM_ABANDONED"
  | "REVIEW_DEADLINE_EXCEEDED"
  | "HANDOFF_PROCESS_FAILED"
  | "HANDOFF_CLEANUP_FAILED"
  | "WORKER_CLAIM_FAILED"
  | "WORKER_FAILED"
  | `REMEDIATION_${ClaudeRemediationInvalidReason}`
  | "REMEDIATION_PROJECT_MODEL_IGNORED"
  | "PROPOSAL_DELIVERY_DOWNGRADED"
  | `PROPOSAL_REQUEST_WRITTEN:${"USER" | "AGENT"}`
  | "PROPOSAL_REQUEST_WRITE_FAILED";

export interface WorkerLogEntry {
  readonly timestamp: string;
  readonly code: WorkerLogCode;
}

/** User-only presentation feed; never throws. */
export interface WorkerReviewFeed {
  started(handoff: ClaudeReviewHandoff): void;
  /** `true` when the record was written; `false` when the feed could not take it. */
  recorded(handoff: ClaudeReviewHandoff, review: TurnReview, proposal: boolean): boolean;
  sweep(): void;
}

export interface WorkerHistory {
  append(entry: ReviewLogEntry): Promise<void>;
}

/** Everything the review worker needs from its host; tests substitute fakes. */
export interface WorkerDependencies {
  readonly handoffDirectory: string;
  readonly files: WorkerFileSystem;
  readonly now: () => Date;
  readonly history: WorkerHistory;
  readonly feed: WorkerReviewFeed;
  readonly policyFor: (projectRoot: string) => PolicyLoader;
  readonly parseConfig: PolicyConfigParser;
  /** The user's opt-in for remediation in one project; read only for a unit that can be reviewed. */
  readonly remediationFor: (projectRoot: string) => ClaudeRemediationSettingsResult;
  readonly proposals: WorkerProposalStore;
  /** Builds a fresh Jev port per handoff, so one stuck review never holds another's slots. */
  readonly jevFor: () => JevEvaluationPort;
  readonly deadline: ReviewDeadline;
  readonly log: (code: WorkerLogCode) => void;
  readonly reviewDeadlineMs?: number;
}

export type HandoffParseResult =
  | { readonly status: "VALID"; readonly handoff: ClaudeReviewHandoff }
  | { readonly status: "INVALID" };

export interface ReviewedHandoff {
  readonly review: TurnReview;
  readonly deadlineExceeded: boolean;
  /** The complete, safe proposal request, only when proposals were enabled and the review has a FAIL. */
  readonly proposal: RemediationProposalRequest | null;
  /** The project's `.jev` pinned a remediation model, which Claude Code ignores. */
  readonly projectModelIgnored: boolean;
}

export type ResolvedReview = Omit<ReviewedHandoff, "deadlineExceeded">;

export interface ReviewHandoffOptions {
  readonly proposals: boolean;
}
