import {
  DEFAULT_REMEDIATION_CONFIG,
  type ProposalTrigger,
  type RemediationConfig,
  type RemediationConfigResult,
} from "./types";

/** Exactly one nonempty, whitespace-free provider and model, separated by `/`. */
const MODEL_PATTERN = /^[^\s/]+\/[^\s/]+$/;
const KNOWN_KEYS: ReadonlySet<string> = new Set(["auto_propose", "propose_on", "model"]);

/**
 * Validates the optional `remediation` section of `.jev/config.yaml`. Absent config
 * or an absent section uses the documented defaults. A present section that does not
 * validate exactly is `INVALID_CONFIG` rather than guessed, so a typo can never
 * silently disable or broaden automatic proposals.
 */
export function resolveRemediationConfig(value: unknown): RemediationConfigResult {
  if (value === null || value === undefined) {
    return valid(DEFAULT_REMEDIATION_CONFIG);
  }

  if (!isRecord(value)) {
    return invalid();
  }

  const remediation = value.remediation;

  if (remediation === undefined) {
    return valid(DEFAULT_REMEDIATION_CONFIG);
  }

  if (!isRecord(remediation) || hasUnknownKey(remediation)) {
    return invalid();
  }

  const autoPropose = remediation.auto_propose ?? DEFAULT_REMEDIATION_CONFIG.autoPropose;

  if (typeof autoPropose !== "boolean") {
    return invalid();
  }

  const proposeOn = readProposeOn(remediation.propose_on);

  if (proposeOn === null) {
    return invalid();
  }

  const model = remediation.model ?? DEFAULT_REMEDIATION_CONFIG.model;

  if (typeof model !== "string" || !MODEL_PATTERN.test(model)) {
    return invalid();
  }

  return valid({ autoPropose, proposeOn, model });
}

/**
 * Splits one `provider/model` specifier. Returns `null` for anything that is not
 * exactly one nonempty provider and model, so a malformed specifier never reaches a
 * host model call.
 */
export function parseModelSpecifier(
  model: string,
): { readonly providerID: string; readonly modelID: string } | null {
  if (!MODEL_PATTERN.test(model)) {
    return null;
  }

  const separator = model.indexOf("/");

  return {
    providerID: model.slice(0, separator),
    modelID: model.slice(separator + 1),
  };
}

function readProposeOn(value: unknown): readonly ProposalTrigger[] | null {
  if (value === undefined) {
    return DEFAULT_REMEDIATION_CONFIG.proposeOn;
  }

  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const triggers: ProposalTrigger[] = [];

  for (const entry of value) {
    if (entry !== "FAIL") {
      return null;
    }

    triggers.push(entry);
  }

  return triggers;
}

function hasUnknownKey(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => !KNOWN_KEYS.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valid(config: RemediationConfig): RemediationConfigResult {
  return { status: "VALID", config };
}

function invalid(): RemediationConfigResult {
  return { status: "INVALID", reason: "INVALID_CONFIG" };
}
