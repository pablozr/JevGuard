import type { ReviewResult } from "@jevguard/core";
import { formatRuleLabel } from "./log";
import type { ReviewToast, ToastVariant } from "./types";

export function toReviewToast(result: ReviewResult): ReviewToast {
  const rule = formatRuleLabel(result.ruleId);

  switch (result.outcome) {
    case "PASS":
      return semanticToast(result.outcome, rule, result.violationProbability, "success");
    case "WARN":
      return semanticToast(result.outcome, rule, result.violationProbability, "warning");
    case "FAIL":
      return semanticToast(result.outcome, rule, result.violationProbability, "error");
    case "SKIPPED":
      return {
        title: `JevGuard ${result.outcome}`,
        message: `${rule} · ${result.reason}`,
        variant: "info",
      };
    case "UNAVAILABLE":
      return {
        title: `JevGuard ${result.outcome}`,
        message: `${rule} · ${result.reason}`,
        variant: "error",
      };
  }
}

function semanticToast(
  outcome: "PASS" | "WARN" | "FAIL",
  rule: string,
  probability: number,
  variant: ToastVariant,
): ReviewToast {
  return {
    title: `JevGuard ${outcome}`,
    message: `${rule} · probability ${probability.toFixed(2)}`,
    variant,
  };
}
