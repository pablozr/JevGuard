import { checkHint, checkLine, type DescribedCheck } from "@jevguard/node-infra";
import { JEVGUARD_PLUGIN_VERSION } from "../opencode-config/entry";
import type { PluginResolution } from "../opencode-config/resolution";
import type { InstallInspection } from "../opencode-config/types";
import { describeInstallFailure } from "./install-messages";
import type { OpenCodePluginCheckCode, OpenCodeRuntimeCheckCode } from "./types";

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

/**
 * Human text for the runtime-resolution check. It never names a cache path: the report
 * carries the package and the version, and the hint says what to do next.
 */
export function describeOpenCodeRuntime(
  code: OpenCodeRuntimeCheckCode,
  resolution: PluginResolution | null,
): DescribedCheck {
  switch (code) {
    case "RESOLVED":
      return checkLine(
        resolution === null || !("version" in resolution)
          ? "JevGuard resolves at runtime."
          : `JevGuard resolves at runtime: ${resolution.package} ${resolution.version} in the host cache.`,
      );
    case "VERSION_MISMATCH":
      return checkLine(
        resolution === null || resolution.status !== "VERSION_MISMATCH"
          ? "The cached JevGuard version does not match the entry."
          : `JevGuard resolves ${resolution.package} ${resolution.version} in the host cache, but the entry pins ${resolution.pin}.`,
        checkHint("Restart OpenCode so it installs the pinned version."),
      );
    case "DIVERGENT_ENTRIES":
      return checkLine(
        resolution === null || !("version" in resolution)
          ? "The registered JevGuard entries disagree on the version, so its runtime resolution cannot be proven."
          : `The registered JevGuard entries disagree on the version (${resolution.version} and others), so its runtime resolution cannot be proven.`,
        checkHint("Run `jevguard install` so every entry carries the same pinned version."),
      );
    case "NOT_CACHED":
      return checkLine(
        resolution === null
          ? "The host cache holds no JevGuard package, so its runtime resolution cannot be proven."
          : `${resolution.package} is registered but not in the host cache, so its runtime resolution cannot be proven.`,
        checkHint(
          "Start OpenCode once so it installs the plugin, then run `jevguard doctor` again.",
        ),
      );
    case "UNREADABLE":
      return checkLine(
        resolution === null
          ? "The cached JevGuard package could not be read, so its runtime resolution cannot be proven."
          : `The cached ${resolution.package} package could not be read, so its runtime resolution cannot be proven.`,
        checkHint("Run `jevguard install` and restart OpenCode."),
      );
    case "UNSUPPORTED":
      return checkLine(
        resolution === null
          ? "The JevGuard entry is not a registry spec, so its runtime resolution cannot be proven."
          : `The ${resolution.package} entry is not a registry spec, so its runtime resolution cannot be proven.`,
        checkHint("Register the published package with `jevguard install` to have it checked."),
      );
    case "NOT_REGISTERED":
      return checkLine(
        "There is no registered JevGuard entry to resolve.",
        checkHint("Run `jevguard install` (or `jevguard install --project`)."),
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
