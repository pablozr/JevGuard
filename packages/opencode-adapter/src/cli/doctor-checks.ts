import {
  type HostCheckStatus,
  type HostCliContext,
  type HostDoctorCheck,
  versionDoctorCheck,
} from "@jevguard/node-infra";
import { JEVGUARD_PLUGIN_VERSION } from "../opencode-config/entry";
import { createConfigFileSystem } from "../opencode-config/file-system";
import { inspectInstall } from "../opencode-config/inspect";
import type { InstallInspection, InstallTarget } from "../opencode-config/types";
import { OPENCODE_COMMAND } from "./constants";
import { detectOpenCode } from "./detect";
import { describeOpenCodePlugin } from "./doctor-messages";
import { pathContext } from "./path-context";
import type { OpenCodePluginCheckCode } from "./types";

const TARGETS: readonly InstallTarget[] = ["global", "project"];

type RegisteredInspection = Extract<InstallInspection, { status: "REGISTERED" }>;

export async function openCodeDoctorChecks(
  context: HostCliContext,
): Promise<readonly HostDoctorCheck[]> {
  const [targets, detection] = await Promise.all([
    inspectTargets(context),
    detectOpenCode(context),
  ]);

  return [
    pluginCheck(targets),
    versionDoctorCheck(detection, {
      id: "opencode-version",
      displayName: "OpenCode",
      command: OPENCODE_COMMAND,
    }),
  ];
}

function inspectTargets(context: HostCliContext): Promise<readonly InstallInspection[]> {
  const fileSystem = createConfigFileSystem(context.files);

  return Promise.all(
    TARGETS.map((target) => inspectInstall({ ...pathContext(context), target, fileSystem })),
  );
}

function registered(targets: readonly InstallInspection[]): readonly RegisteredInspection[] {
  return targets.filter((target): target is RegisteredInspection => target.status === "REGISTERED");
}

/**
 * A registered entry only counts as a healthy setup when it pins the version this CLI
 * knows; an unpinned entry makes the host resolve `@latest`, which the doctor must not
 * report as OK.
 */
function pluginCode(targets: readonly InstallInspection[]): OpenCodePluginCheckCode {
  if (targets.some((target) => target.status === "FAILED")) {
    return "INSPECTION_FAILED";
  }

  const entries = registered(targets);

  if (entries.length === 0) {
    return "NOT_REGISTERED";
  }

  if (entries.every((entry) => entry.pin === JEVGUARD_PLUGIN_VERSION)) {
    return "REGISTERED";
  }

  return entries.some((entry) => entry.pin !== null) ? "PIN_MISMATCH" : "PIN_MISSING";
}

function pluginCheck(targets: readonly InstallInspection[]): HostDoctorCheck {
  const code = pluginCode(targets);
  const status: HostCheckStatus = code === "REGISTERED" ? "OK" : "WARN";
  const described = describeOpenCodePlugin(code, targets);

  return {
    json: { id: "opencode-plugin", status, code, targets },
    message: described.message,
    annotation: described.annotation,
  };
}
