import { checkHint, checkLine, type DescribedCheck } from "@jevguard/node-infra";
import { JEVGUARD_PLUGIN_VERSION } from "../opencode-config/entry";
import type { InstallInspection } from "../opencode-config/types";
import { describeInstallFailure } from "./install-messages";
import type { OpenCodePluginCheckCode } from "./types";

type RegisteredInspection = Extract<InstallInspection, { status: "REGISTERED" }>;

const REPIN_HINT = checkHint(
  "Run `jevguard install` (or `jevguard install --project`) to update the pin.",
);

export function describeOpenCodePlugin(
  code: OpenCodePluginCheckCode,
  targets: readonly InstallInspection[],
): DescribedCheck {
  const entries = registeredEntries(targets);

  switch (code) {
    case "REGISTERED":
      return checkLine(
        `JevGuard is registered in ${pathsOf(entries)}, pinned at ${JEVGUARD_PLUGIN_VERSION}.`,
      );
    case "PIN_MISMATCH":
      return checkLine(
        `JevGuard is registered in ${describeEntries(entries)}, but this CLI pins ${JEVGUARD_PLUGIN_VERSION}.${legacyNote(entries)}`,
        REPIN_HINT,
      );
    case "PIN_MISSING":
      return checkLine(
        `JevGuard is registered in ${pathsOf(entries)} without a version, so OpenCode installs the latest release instead of ${JEVGUARD_PLUGIN_VERSION}.${legacyNote(entries)}`,
        REPIN_HINT,
      );
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

function registeredEntries(targets: readonly InstallInspection[]): readonly RegisteredInspection[] {
  return targets.filter((target): target is RegisteredInspection => target.status === "REGISTERED");
}

function pathsOf(entries: readonly RegisteredInspection[]): string {
  return entries.map((entry) => entry.path).join(" and ");
}

function describeEntries(entries: readonly RegisteredInspection[]): string {
  return entries
    .map((entry) =>
      entry.pin === null ? `${entry.path} (unpinned)` : `${entry.path} (pinned at ${entry.pin})`,
    )
    .join(" and ");
}

/** Names the legacy key when install will update the entry there. */
function legacyNote(entries: readonly RegisteredInspection[]): string {
  return entries.some((entry) => entry.legacy)
    ? " The entry is in the legacy `plugin` key; `jevguard install` updates it there."
    : "";
}

function describeInspectionFailures(targets: readonly InstallInspection[]): string {
  return targets
    .flatMap((target) =>
      target.status === "FAILED" ? [describeInstallFailure(target.reason, target.path)] : [],
    )
    .join("\n");
}
