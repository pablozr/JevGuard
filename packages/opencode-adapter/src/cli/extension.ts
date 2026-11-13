import type {
  HostCliContext,
  HostCliExtension,
  HostInstallInspection,
  HostInstallOutcome,
  HostInstallScope,
} from "@jevguard/node-infra";
import { OPENCODE_CONFIG_FILE_NAME } from "../opencode-config/constants";
import { createConfigFileSystem } from "../opencode-config/file-system";
import { inspectInstall } from "../opencode-config/inspect";
import { install } from "../opencode-config/install";
import type { InstallOutcome } from "../opencode-config/types";
import { detectOpenCode } from "./detect";
import { openCodeDoctorChecks } from "./doctor-checks";
import {
  describeInstallAborted,
  describeInstallAlreadyInstalled,
  describeInstallFailure,
  describeInstallInstalled,
} from "./install-messages";
import { pathContext } from "./path-context";

const INSPECTION_STATES = {
  REGISTERED: "INSTALLED",
  NOT_REGISTERED: "NOT_INSTALLED",
  FAILED: "UNKNOWN",
} as const;

async function inspectOpenCodeInstall(
  context: HostCliContext,
  scope: HostInstallScope,
): Promise<HostInstallInspection> {
  const inspection = await inspectInstall({
    ...pathContext(context),
    target: scope,
    fileSystem: createConfigFileSystem(context.files),
  });

  return { state: INSPECTION_STATES[inspection.status], target: inspection.path };
}

function outcomeOf(outcome: InstallOutcome): HostInstallOutcome {
  switch (outcome.status) {
    case "INSTALLED":
      return {
        status: "CHANGED",
        code: "INSTALLED",
        lines: [describeInstallInstalled(outcome.target, outcome.path)],
      };
    case "ALREADY_INSTALLED":
      return {
        status: "UNCHANGED",
        code: "ALREADY_INSTALLED",
        lines: [describeInstallAlreadyInstalled(outcome.target, outcome.path)],
      };
    case "ABORTED":
      return {
        status: "DECLINED",
        code: "ABORTED",
        lines: [describeInstallAborted(outcome.path)],
      };
    case "FAILED":
      return {
        status: "FAILED",
        code: outcome.reason,
        lines: [describeInstallFailure(outcome.reason, outcome.path)],
      };
  }
}

async function installOpenCode(
  context: HostCliContext,
  scope: HostInstallScope,
): Promise<HostInstallOutcome> {
  const outcome = await install({
    ...pathContext(context),
    target: scope,
    confirmation: context.confirmation,
    fileSystem: createConfigFileSystem(context.files),
  });

  return outcomeOf(outcome);
}

/** The OpenCode side of the host-neutral CLI: plugin registration in `opencode.json`. */
export function createOpenCodeCliExtension(): HostCliExtension {
  return {
    id: "opencode",
    displayName: "OpenCode",
    userConfigFileName: OPENCODE_CONFIG_FILE_NAME,
    remediationRules: {},
    detect: detectOpenCode,
    inspectInstall: inspectOpenCodeInstall,
    install: installOpenCode,
    doctor: openCodeDoctorChecks,
  };
}
