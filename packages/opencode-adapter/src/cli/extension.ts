import type {
  HostCliContext,
  HostCliExtension,
  HostInstallInspection,
  HostInstallOutcome,
  HostInstallScope,
} from "@jevguard/node-infra";
import { OPENCODE_CONFIG_FILE_NAME } from "../opencode-config/constants";
import { JEVGUARD_PLUGIN_VERSION } from "../opencode-config/entry";
import { createConfigFileSystem } from "../opencode-config/file-system";
import { inspectInstall } from "../opencode-config/inspect";
import { install } from "../opencode-config/install";
import type { InstallInspection, InstallOutcome } from "../opencode-config/types";
import { detectOpenCode } from "./detect";
import { type OpenCodeDoctorDependencies, openCodeDoctorChecks } from "./doctor-checks";
import {
  describeInstallAborted,
  describeInstallAlreadyInstalled,
  describeInstallFailure,
  describeInstallInstalled,
  describeInstallUpdated,
} from "./install-messages";
import { pathContext } from "./path-context";

/**
 * A registered entry counts as installed only when it pins the version this CLI knows.
 * An unpinned or older entry is reported as not installed, so `setup` offers the
 * install step that re-pins it.
 */
function installStateOf(inspection: InstallInspection): HostInstallInspection["state"] {
  switch (inspection.status) {
    case "REGISTERED":
      return inspection.pin === JEVGUARD_PLUGIN_VERSION ? "INSTALLED" : "NOT_INSTALLED";
    case "NOT_REGISTERED":
      return "NOT_INSTALLED";
    case "FAILED":
      return "UNKNOWN";
  }
}

async function inspectOpenCodeInstall(
  context: HostCliContext,
  scope: HostInstallScope,
): Promise<HostInstallInspection> {
  const inspection = await inspectInstall({
    ...pathContext(context),
    target: scope,
    fileSystem: createConfigFileSystem(context.files),
  });

  return { state: installStateOf(inspection), target: inspection.path };
}

function outcomeOf(outcome: InstallOutcome): HostInstallOutcome {
  switch (outcome.status) {
    case "INSTALLED":
      return {
        status: "CHANGED",
        code: "INSTALLED",
        lines: [describeInstallInstalled(outcome.target, outcome.path)],
      };
    case "UPDATED":
      return {
        status: "CHANGED",
        code: "UPDATED",
        lines: [describeInstallUpdated(outcome.target, outcome.path, outcome.from)],
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
export function createOpenCodeCliExtension(
  dependencies: OpenCodeDoctorDependencies = {},
): HostCliExtension {
  return {
    id: "opencode",
    displayName: "OpenCode",
    userConfigFileName: OPENCODE_CONFIG_FILE_NAME,
    remediationRules: {},
    detect: detectOpenCode,
    inspectInstall: inspectOpenCodeInstall,
    install: installOpenCode,
    doctor: (context) => openCodeDoctorChecks(context, dependencies),
  };
}
