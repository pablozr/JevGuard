import {
  type HostCheckStatus,
  type HostCliContext,
  type HostDoctorCheck,
  versionDoctorCheck,
} from "@jevguard/node-infra";
import { createConfigFileSystem } from "../opencode-config/file-system";
import { inspectInstall } from "../opencode-config/inspect";
import type { InstallInspection, InstallTarget } from "../opencode-config/types";
import { OPENCODE_COMMAND } from "./constants";
import { detectOpenCode } from "./detect";
import { describeOpenCodePlugin } from "./doctor-messages";
import { pathContext } from "./path-context";
import type { OpenCodePluginCheckCode } from "./types";

const TARGETS: readonly InstallTarget[] = ["global", "project"];

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

function pluginCode(targets: readonly InstallInspection[]): OpenCodePluginCheckCode {
  if (targets.some((target) => target.status === "FAILED")) {
    return "INSPECTION_FAILED";
  }

  if (targets.some((target) => target.status === "REGISTERED")) {
    return "REGISTERED";
  }

  return "NOT_REGISTERED";
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
