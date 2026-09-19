import type { GateConfig, GateResult, UnavailableReason } from "../domain/types";

export type InvalidConfigReason = Extract<UnavailableReason, "INVALID_CONFIG">;

export type GateConfigResult =
  | { readonly status: "VALID"; readonly config: GateConfig }
  | { readonly status: "INVALID"; readonly reason: InvalidConfigReason };

/**
 * A Jev probability that is not in `[0, 1]` is not a semantic verdict and never
 * becomes `PASS`, `WARN`, or `FAIL`.
 */
export type GateUnavailable = {
  readonly outcome: "UNAVAILABLE";
  readonly reason: Extract<UnavailableReason, "JEV_FAILURE">;
};

export type GateEvaluation = GateResult | GateUnavailable;
