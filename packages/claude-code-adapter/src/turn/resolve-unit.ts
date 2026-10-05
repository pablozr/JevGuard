import type { ClaudeAcquisitionReason, UnitAcquisition } from "../acquisition";
import { PatchBudgetExceededError } from "./build-patch";
import { toTurn } from "./to-turn";
import type { TurnOptions, TurnResolution, TurnUnavailableReason } from "./types";

function coreReason(causes: readonly ClaudeAcquisitionReason[]): TurnUnavailableReason {
  return causes.includes("BLOCKED_PATH") ? "BLOCKED_EVIDENCE" : "MISSING_ATTRIBUTED_DIFF";
}

/** Maps an acquisition result onto core's turn or operational outcome. */
export function resolveAcquisition(
  acquisition: UnitAcquisition,
  options: TurnOptions = {},
): TurnResolution {
  switch (acquisition.status) {
    case "SKIPPED":
      return { status: "SKIPPED", reason: acquisition.reason };
    case "UNAVAILABLE":
      return {
        status: "UNAVAILABLE",
        reason: coreReason(acquisition.reasons),
        causes: acquisition.reasons,
      };
    case "READY": {
      try {
        const turn = toTurn(acquisition.unit, options);

        if (turn.files.length === 0) return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };

        return { status: "TURN", turn };
      } catch (error) {
        if (!(error instanceof PatchBudgetExceededError)) throw error;

        return {
          status: "UNAVAILABLE",
          reason: "MISSING_ATTRIBUTED_DIFF",
          causes: ["PATCH_BUDGET_EXCEEDED"],
        };
      }
    }
  }
}
