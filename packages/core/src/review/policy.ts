import { resolveGateConfig } from "../gate/config";
import type { PolicyConfigParser, PolicyLoader, PolicyLoadResult } from "../ports/types";
import { resolveRemediationConfig } from "../remediation/config";
import type { PolicyConfig, PolicyConfigDiagnosis } from "./types";

/**
 * Reads the policy loader once for the rule lane. A rejected promise is an unknown
 * infrastructure failure, contained here as `null` so it can degrade only the rule
 * lane and never reach the built-in lane or the presenter.
 */
export async function loadPolicy(policy: PolicyLoader): Promise<PolicyLoadResult | null> {
  try {
    return await policy.load();
  } catch {
    return null;
  }
}

export function readPolicyConfig(
  loaded: PolicyLoadResult | null,
  parseConfig: PolicyConfigParser,
): PolicyConfig {
  if (loaded === null || loaded.status === "FAILED") {
    return invalidPolicyConfig();
  }

  return diagnosePolicyConfig(loaded.source.config, parseConfig).config;
}

/**
 * Diagnoses optional `.jev/config.yaml` text once: absent text is the defaults, and
 * unparseable, gate-invalid or remediation-invalid text degrades both sections to
 * `INVALID_CONFIG`. The first failing stage wins, in that order.
 */
export function diagnosePolicyConfig(
  config: string | null,
  parseConfig: PolicyConfigParser,
): PolicyConfigDiagnosis {
  const parsed = config === null ? null : parseConfig(config);

  if (parsed !== null && parsed.status !== "PARSED") {
    return { code: "PARSE_INVALID", config: invalidPolicyConfig() };
  }

  const value = parsed === null ? null : parsed.value;
  const gate = resolveGateConfig(value);
  const remediation = resolveRemediationConfig(value);

  if (gate.status === "INVALID") {
    return { code: "GATE_INVALID", config: invalidPolicyConfig() };
  }

  if (remediation.status === "INVALID") {
    return { code: "REMEDIATION_INVALID", config: invalidPolicyConfig() };
  }

  return { code: config === null ? "DEFAULTS" : "VALID", config: { gate, remediation } };
}

function invalidPolicyConfig(): PolicyConfig {
  return {
    gate: { status: "INVALID", reason: "INVALID_CONFIG" },
    remediation: { status: "INVALID", reason: "INVALID_CONFIG" },
  };
}
