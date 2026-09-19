import type { ReviewOutcome, ReviewResult } from "@jevguard/core";
import type { ReviewLogEntry } from "./types";

const RULE_FALLBACK = "unknown";

export function toReviewLogEntry(result: ReviewResult): ReviewLogEntry {
  const context = {
    turnId: result.turnId,
    ruleId: result.ruleId,
    severity: result.severity,
    scopedPaths: [...result.scopedPaths],
  };

  switch (result.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return {
        ...context,
        outcome: result.outcome,
        violationProbability: result.violationProbability,
      };
    case "SKIPPED":
    case "UNAVAILABLE":
      return { ...context, outcome: result.outcome, reason: result.reason };
  }
}

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
  const rule = formatRuleLabel(entry.ruleId);

  switch (entry.outcome) {
    case "PASS":
    case "WARN":
    case "FAIL":
      return `JevGuard ${entry.outcome} for ${rule} (probability ${entry.violationProbability})`;
    case "SKIPPED":
    case "UNAVAILABLE":
      return `JevGuard ${entry.outcome} for ${rule} (${entry.reason})`;
  }
}

export function formatRuleLabel(ruleId: string | null): string {
  return ruleId ?? RULE_FALLBACK;
}
