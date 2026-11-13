import { normalize } from "node:path";
import type { CredentialSource } from "@jevguard/core";
import type {
  AgentDeliveryInspection,
  HostCliExtension,
  HostDetection,
} from "@jevguard/node-infra";
import type { SetupPlan, SetupStep } from "./types";

export function noHostMessage(extensions: readonly HostCliExtension[]): string {
  const names = extensions.map((extension) => extension.displayName).join(" or ");

  return `No supported host was found. Install ${names}, or run \`jevguard doctor\`.`;
}

export const SETUP_NOT_CONFIRMED_MESSAGE =
  "Nothing was changed. Re-run `jevguard setup --yes` to apply this plan.";

export const CREDENTIAL_LOGIN_HINT = "Run `jevguard login` in a terminal to store your API key.";

const DOCTOR_HINT = "Next: run `jevguard doctor` to check the setup.";

/** Suggests `jevguard login` only while the credential is still missing. */
export function nextSteps(credentialMissing: boolean): readonly string[] {
  return credentialMissing
    ? [
        "Next: run `jevguard login` to store your API key, then `jevguard doctor` to check the setup.",
      ]
    : [DOCTOR_HINT];
}

const MARKERS = { PENDING: "[todo]", DONE: "[done]", SKIPPED: "[skip]" } as const;

function describeDetection(extension: HostCliExtension, detection: HostDetection): string {
  const name = extension.displayName;

  switch (detection.status) {
    case "NOT_FOUND":
      return `${name}: not found on PATH, skipped`;
    case "UNKNOWN_VERSION":
      return `${name}: version could not be read, skipped`;
    case "UNSUPPORTED":
      return `${name} ${detection.version}: unsupported (needs ${detection.supportedRange}), skipped`;
    case "SUPPORTED":
      return `${name} ${detection.version}: supported`;
  }
}

function describeDelivery(
  extension: HostCliExtension,
  inspection: AgentDeliveryInspection,
): string {
  const name = extension.displayName;

  switch (inspection.status) {
    case "WOULD_ENABLE":
      return `${name}: enable \`delivery: agent\` in ${displayPath(inspection.path)}`;
    case "ALREADY_ENABLED":
      return `${name}: \`delivery: agent\` is already enabled`;
    case "INVALID_EXISTING":
      return `${name}: ${displayPath(inspection.path)} is not valid, left untouched`;
    case "INSIDE_PROJECT":
      return `${name}: ${displayPath(inspection.path)} lies inside the project, left untouched`;
    case "NO_CONFIG_HOME":
      return `${name}: no user config home was found, \`delivery: agent\` not enabled`;
  }
}

function describeCredential(source: CredentialSource | null): string {
  switch (source) {
    case null:
      return "store your Jev API key in the OS credential store (hidden prompt)";
    case "STORE":
      return "Jev API key found in the OS credential store";
    case "ENVIRONMENT":
      return "Jev API key provided by the TYPESAFE_API_KEY override";
  }
}

function describePolicy(step: Extract<SetupStep, { kind: "POLICY" }>): string {
  if (step.status === "DONE") return `${step.path} already exists`;

  const hint = step.requested ? "" : " (asked interactively; pass --init to create it with --yes)";

  return `create a starter ${step.path}${hint}`;
}

function describeInstall(step: Extract<SetupStep, { kind: "INSTALL" }>): string {
  const name = step.extension.displayName;

  return step.status === "DONE"
    ? `${name}: JevGuard is already installed (${step.scope})`
    : `${name}: install JevGuard (${step.scope})`;
}

/** The step as a sentence without its closing punctuation. */
function statementOf(step: SetupStep): string {
  switch (step.kind) {
    case "CREDENTIAL":
      return describeCredential(step.source);
    case "INSTALL":
      return describeInstall(step);
    case "AGENT_DELIVERY":
      return describeDelivery(step.extension, step.inspection);
    case "POLICY":
      return describePolicy(step);
    case "HOST":
      return describeDetection(step.extension, step.detection);
  }
}

/** The step as one plan line, without its status marker. */
export function lineOf(step: SetupStep): string {
  return `${statementOf(step)}.`;
}

export function describeStep(step: SetupStep): string {
  return `${MARKERS[step.status]} ${lineOf(step)}`;
}

/** The y/N question asked for a step that is offered rather than requested. */
export function questionOf(step: SetupStep): string {
  if (step.kind === "AGENT_DELIVERY") {
    const target =
      step.inspection.path === null ? "your user config" : displayPath(step.inspection.path);

    return `Let ${step.extension.displayName} deliver JevGuard findings and the fix strategy to the agent automatically (delivery: agent, written to ${target})?`;
  }

  return `${statementOf(step)}?`;
}

export function describePlan(plan: SetupPlan): readonly string[] {
  return ["JevGuard setup plan", ...plan.steps.map(describeStep)];
}

/** A host path as the OS writes it, or a neutral name when there is none. */
export function displayPath(path: string | null): string {
  return path === null ? "the user config file" : normalize(path);
}
