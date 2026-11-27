import type {
  ConfirmationResult,
  LocalEnforceAckStore,
  LocalReviewHistory,
} from "@jevguard/node-infra";

export type AckArguments =
  | { readonly kind: "LIST" }
  | { readonly kind: "ACK"; readonly number: number }
  | { readonly kind: "USAGE" };

/** One unit the `Stop` gate could block, numbered from the current history read. */
export interface AckCandidate {
  readonly number: number;
  readonly turnId: string;
  readonly ruleIds: readonly string[];
  readonly timestamp: string;
}

export type AckListResult =
  | {
      readonly status: "LISTED";
      readonly total: number;
      readonly items: readonly AckCandidate[];
    }
  | { readonly status: "READ_FAILED" };

export type AckResult =
  | {
      readonly status: "RECORDED";
      readonly turnId: string;
      readonly ruleIds: readonly string[];
    }
  | { readonly status: "DECLINED" }
  | { readonly status: "NUMBER_OUT_OF_RANGE" }
  | { readonly status: "NOT_INTERACTIVE" }
  | { readonly status: "READ_FAILED" }
  | { readonly status: "WRITE_FAILED" };

/**
 * Everything `jevguard ack` reads or writes. The terminal check and the confirmation
 * are injected so an agent shell can never acknowledge a unit: no flag skips them.
 */
export interface AckDependencies {
  readonly history: Pick<LocalReviewHistory, "readStrict">;
  readonly acks: LocalEnforceAckStore;
  readonly now: () => Date;
  readonly isInteractiveTerminal: () => boolean;
  readonly confirm: (message: string) => Promise<ConfirmationResult>;
}

/** The real wiring, with the full history surface kept for other commands. */
export interface ProcessAckDependencies extends AckDependencies {
  readonly history: LocalReviewHistory;
}
