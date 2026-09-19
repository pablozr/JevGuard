import { DEFAULT_GATE_CONFIG } from "./defaults";
import { isProbability } from "./probability";
import type { GateConfigResult } from "./types";

type UnknownRecord = Record<string, unknown>;

/**
 * Validates a parsed `.jev/config.yaml` value against version 1 and `[0, 1]`
 * threshold bounds. Absent configuration uses the documented defaults; a present
 * configuration that does not validate is `INVALID_CONFIG` rather than guessed.
 */
export function resolveGateConfig(value: unknown): GateConfigResult {
  if (value === null || value === undefined) {
    return { status: "VALID", config: DEFAULT_GATE_CONFIG };
  }

  if (!isRecord(value) || value.version !== 1) {
    return invalid();
  }

  const thresholds = value.thresholds;

  if (!isRecord(thresholds)) {
    return invalid();
  }

  const error = thresholds.error;
  const warning = thresholds.warning;

  if (!isRecord(error) || !isRecord(warning)) {
    return invalid();
  }

  const errorWarn = error.warn;
  const errorFail = error.fail;
  const warningWarn = warning.warn;

  if (!isProbability(errorWarn) || !isProbability(errorFail) || !isProbability(warningWarn)) {
    return invalid();
  }

  if (errorWarn >= errorFail) {
    return invalid();
  }

  return {
    status: "VALID",
    config: {
      version: 1,
      thresholds: {
        error: { warn: errorWarn, fail: errorFail },
        warning: { warn: warningWarn },
      },
    },
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(): GateConfigResult {
  return { status: "INVALID", reason: "INVALID_CONFIG" };
}
