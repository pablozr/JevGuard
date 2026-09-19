import type { ErrorThresholds, GateConfig, RuleSeverity, WarningThresholds } from "../domain/types";
import { isProbability } from "./probability";
import type { GateEvaluation } from "./types";

/**
 * Converts a raw Jev violation probability into a local verdict with exact threshold
 * boundaries. An out-of-range probability produces `UNAVAILABLE` and never a
 * semantic verdict.
 */
export function evaluateGate(
  severity: RuleSeverity,
  violationProbability: number,
  config: GateConfig,
): GateEvaluation {
  if (!isProbability(violationProbability)) {
    return { outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };
  }

  switch (severity) {
    case "error":
      return evaluateErrorGate(violationProbability, config.thresholds.error);
    case "warning":
      return evaluateWarningGate(violationProbability, config.thresholds.warning);
  }
}

function evaluateErrorGate(probability: number, thresholds: ErrorThresholds): GateEvaluation {
  if (probability < thresholds.warn) {
    return { outcome: "PASS", violationProbability: probability };
  }

  if (probability < thresholds.fail) {
    return { outcome: "WARN", violationProbability: probability };
  }

  return { outcome: "FAIL", violationProbability: probability };
}

function evaluateWarningGate(probability: number, thresholds: WarningThresholds): GateEvaluation {
  if (probability < thresholds.warn) {
    return { outcome: "PASS", violationProbability: probability };
  }

  return { outcome: "WARN", violationProbability: probability };
}
