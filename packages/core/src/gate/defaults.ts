import type { GateConfig } from "../domain/types";

export const DEFAULT_GATE_CONFIG: GateConfig = {
  version: 1,
  thresholds: {
    error: { warn: 0.4, fail: 0.7 },
    warning: { warn: 0.6 },
  },
};
