import type { PolicySource } from "../ports/types";

/** Local identity of an acquisition attempt, not an episode closure or upstream DTO. */
export interface EpisodeAttemptIdentity {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly rootId: string;
}

/** Exact durable succeeded boundary; never inferred from idle, timestamps or latest messages. */
export interface EpisodeClosureIdentity {
  readonly closureId: string;
  readonly attempt: EpisodeAttemptIdentity;
}

/** Complete textual representation in actual delivery order, not submission order. */
export interface EpisodeRequest {
  readonly deliveryId: string;
  readonly text: string;
}

/** Initial policy bytes frozen with the baseline, including absent files/default selection. */
export interface EpisodePolicySnapshot {
  readonly snapshotId: string;
  readonly source: PolicySource;
}

export interface EpisodeFile {
  readonly path: string;
  readonly patch: string;
}

/** Coverage is an explicit versioned capture contract, not a claim of atomic filesystem reads. */
export interface EpisodeProvenance {
  readonly kind: "OBSERVED_NET_DELTA";
  readonly baselineId: string;
  readonly finalSnapshotId: string;
  readonly coverageId: string;
  readonly captureVersion: string;
  readonly snapshotMode: "NON_ATOMIC";
}

export type EpisodeUnavailableReason =
  | "CAPABILITY_UNAVAILABLE"
  | "BOUNDARY_UNVERIFIED"
  | "BASELINE_UNAVAILABLE"
  | "FINAL_SNAPSHOT_UNAVAILABLE"
  | "HISTORY_UNAVAILABLE"
  | "CONTINUITY_UNVERIFIED"
  | "CONTENT_INCOMPLETE"
  | "INTENTION_LIMIT_EXCEEDED"
  | "ROOT_CHANGED"
  | "COVERAGE_INCOMPLETE"
  | "POLICY_INCONSISTENT"
  | "OVERLAPPING_SESSION"
  | "WRITER_UNSETTLED"
  | "CAPTURE_TIMEOUT"
  | "PERSISTENCE_FAILED"
  | "GENERATION_INVALIDATED";

/**
 * Acquisition states only, not semantic review results. READY requires verified
 * continuity, complete ordered requests, immutable evidence and settled known writers.
 * Types do not validate IDs, ordering, coverage or cross-field correlations; the
 * acquiring adapter must establish these invariants before constructing READY.
 * Shutdown without a verifiable closure remains OPEN. An invalidated attempt cannot
 * become READY through late results. No state authorizes rereading the current tree.
 */
export type ReviewEpisode =
  | {
      readonly status: "OPEN";
      readonly attempt: EpisodeAttemptIdentity;
    }
  | {
      readonly status: "READY";
      readonly closure: EpisodeClosureIdentity;
      readonly requests: readonly EpisodeRequest[];
      readonly policy: EpisodePolicySnapshot;
      readonly provenance: EpisodeProvenance;
      readonly files: readonly EpisodeFile[];
    }
  | {
      readonly status: "UNAVAILABLE";
      readonly attempt: EpisodeAttemptIdentity;
      readonly closure: EpisodeClosureIdentity | null;
      readonly reason: EpisodeUnavailableReason;
    };
