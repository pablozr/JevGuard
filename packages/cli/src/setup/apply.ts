import {
  type AgentDeliveryResult,
  enableAgentDelivery,
  type HostCliContext,
  type LoginOutcome,
  policyFilePaths,
} from "@jevguard/node-infra";
import { describeLoginFailure, LOGIN_ABORTED_MESSAGE, LOGIN_SAVED_MESSAGE } from "../messages";
import { agentDeliveryInputOf } from "./agent-delivery-input";
import { CREDENTIAL_LOGIN_HINT, describeStep } from "./messages";
import { scaffoldRules } from "./scaffold";
import type { AgentDeliveryStep, InstallStep, SetupPorts, SetupStep } from "./types";

export interface StepOutcome {
  readonly ok: boolean;
  readonly lines: readonly string[];
}

const ACCEPTING_CONFIRMATION: HostCliContext["confirmation"] = {
  confirm: async () => ({ status: "CONFIRMED" }),
};

function describeLoginOutcome(outcome: LoginOutcome | null): string {
  if (outcome === null) return CREDENTIAL_LOGIN_HINT;

  switch (outcome.status) {
    case "SAVED":
      return LOGIN_SAVED_MESSAGE;
    case "ABORTED":
      return LOGIN_ABORTED_MESSAGE;
    case "FAILED":
      return outcome.reason === "NOT_A_TTY"
        ? CREDENTIAL_LOGIN_HINT
        : describeLoginFailure(outcome.reason);
  }
}

async function applyCredential(ports: SetupPorts): Promise<StepOutcome> {
  const outcome = await ports.login().catch(() => null);

  return { ok: outcome?.status === "SAVED", lines: [describeLoginOutcome(outcome)] };
}

async function applyInstall(ports: SetupPorts, step: InstallStep): Promise<StepOutcome> {
  const context = { ...ports.context, confirmation: ACCEPTING_CONFIRMATION };
  const outcome = await step.extension.install(context, step.scope);

  return { ok: outcome.status !== "FAILED" && outcome.status !== "DECLINED", lines: outcome.lines };
}

function describeDeliveryResult(step: AgentDeliveryStep, result: AgentDeliveryResult): string {
  const name = step.extension.displayName;

  return result.status === "ENABLED" || result.status === "ALREADY_ENABLED"
    ? `${name}: \`delivery: agent\` is enabled in ${result.path}.`
    : `${name}: could not enable \`delivery: agent\` (${result.status}).`;
}

async function applyDelivery(ports: SetupPorts, step: AgentDeliveryStep): Promise<StepOutcome> {
  const result = await enableAgentDelivery(agentDeliveryInputOf(ports, step.extension));
  const ok = result.status === "ENABLED" || result.status === "ALREADY_ENABLED";

  return { ok, lines: [describeDeliveryResult(step, result)] };
}

async function applyPolicy(ports: SetupPorts): Promise<StepOutcome> {
  const { files, projectRoot } = ports.context;
  const path = policyFilePaths(projectRoot).rules;
  const result = await scaffoldRules(files, projectRoot);

  if (result === "WRITE_FAILED") return { ok: false, lines: [`Could not write ${path}.`] };

  return {
    ok: true,
    lines: [result === "CREATED" ? `Created ${path}.` : `${path} already exists.`],
  };
}

/** Applies one pending step. A step that is not pending is reported as it was planned. */
export function applyStep(ports: SetupPorts, step: SetupStep): Promise<StepOutcome> {
  switch (step.kind) {
    case "CREDENTIAL":
      return applyCredential(ports);
    case "INSTALL":
      return applyInstall(ports, step);
    case "AGENT_DELIVERY":
      return applyDelivery(ports, step);
    case "POLICY":
      return applyPolicy(ports);
    case "HOST":
      return Promise.resolve({ ok: true, lines: [describeStep(step)] });
  }
}
