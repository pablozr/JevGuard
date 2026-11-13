import { checkHint, checkLine, type DescribedCheck } from "@jevguard/node-infra";
import type { InstallInspection } from "../opencode-config/types";
import { describeInstallFailure } from "./install-messages";
import type { OpenCodePluginCheckCode } from "./types";

export function describeOpenCodePlugin(
  code: OpenCodePluginCheckCode,
  targets: readonly InstallInspection[],
): DescribedCheck {
  switch (code) {
    case "REGISTERED":
      return checkLine(`JevGuard is registered in ${describeRegisteredPaths(targets)}.`);
    case "NOT_REGISTERED":
      return checkLine(
        `JevGuard is not registered in ${targets.map((target) => target.path).join(" or ")}.`,
        checkHint("Run `jevguard install` (or `jevguard install --project`)."),
      );
    case "INSPECTION_FAILED":
      return checkLine(
        "The OpenCode configuration could not be inspected.",
        checkHint(describeInspectionFailures(targets)),
      );
  }
}

function describeRegisteredPaths(targets: readonly InstallInspection[]): string {
  return targets
    .filter((target) => target.status === "REGISTERED")
    .map((target) => target.path)
    .join(" and ");
}

function describeInspectionFailures(targets: readonly InstallInspection[]): string {
  return targets
    .flatMap((target) =>
      target.status === "FAILED" ? [describeInstallFailure(target.reason, target.path)] : [],
    )
    .join("\n");
}
