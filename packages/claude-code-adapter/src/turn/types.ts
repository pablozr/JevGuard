import type { Turn, UnavailableReason } from "@jevguard/core";
import type { ClaudeAcquisitionReason } from "../acquisition";

export interface TurnOptions {
  /** Overrides the id derived from the session and ordinal. */
  readonly turnId?: string;
  /** Time allowance shared by every patch of the unit. */
  readonly patchBudgetMs?: number;
}

export type TurnUnavailableReason = Extract<
  UnavailableReason,
  "MISSING_ATTRIBUTED_DIFF" | "BLOCKED_EVIDENCE"
>;

/**
 * Core-facing result of one acquired unit. `causes` keeps the specific adapter
 * reasons for logging; core only sees `reason`.
 */
export type TurnResolution =
  | { readonly status: "TURN"; readonly turn: Turn }
  | { readonly status: "SKIPPED"; readonly reason: "NO_ATTRIBUTED_PATCH" }
  | {
      readonly status: "UNAVAILABLE";
      readonly reason: TurnUnavailableReason;
      readonly causes: readonly ClaudeAcquisitionReason[];
    };
