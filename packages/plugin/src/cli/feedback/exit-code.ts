import type { FeedbackMarkResult } from "./types";

/**
 * Exit code of an answer: 0 when recorded or already recorded, 1 for an unusable
 * number or an item that left the history, 2 when storage failed.
 */
export function feedbackMarkExitCode(result: FeedbackMarkResult): 0 | 1 | 2 {
  switch (result.status) {
    case "RECORDED":
    case "UNCHANGED":
      return 0;
    case "NO_SELECTION":
    case "NUMBER_OUT_OF_RANGE":
    case "NO_LONGER_IN_HISTORY":
      return 1;
    case "READ_FAILED":
    case "WRITE_FAILED":
      return 2;
  }
}
