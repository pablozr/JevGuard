import type { ReviewOutcome } from "@jevguard/core";
import type { ReviewLogEntry } from "@jevguard/node-infra";
import { displayOutcome } from "./display";

export function logLevelFor(outcome: ReviewOutcome): "info" | "warn" | "error" {
  switch (outcome) {
    case "PASS":
    case "SKIPPED":
      return "info";
    case "WARN":
      return "warn";
    case "FAIL":
    case "UNAVAILABLE":
      return "error";
  }
}

export function reviewLogMessage(entry: ReviewLogEntry): string {
  return `JevGuard ${displayOutcome(entry.summary.counts)} for turn ${entry.turnId}`;
}
