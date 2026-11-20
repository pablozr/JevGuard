import {
  findPluginEntries,
  findPluginEntry,
  JEVGUARD_PLUGIN_ENTRY,
  JEVGUARD_PLUGIN_SPEC,
  pluginVersionOf,
} from "./entry";
import { resolveConfigPath } from "./paths";
import { readConfigDocument } from "./read-document";
import type { InspectInstallDependencies, InstallInspection } from "./types";

/**
 * Read-only counterpart of `install`: reports whether the JevGuard plugin entry is
 * registered in the target `opencode.json`, which version it pins, and every occurrence
 * of the package the host also reads. It never writes
 * and never throws; every failure maps to a typed reason.
 */
export async function inspectInstall(
  dependencies: InspectInstallDependencies,
): Promise<InstallInspection> {
  const { target } = dependencies;
  const path = resolveConfigPath(target, dependencies);
  const read = await readConfigDocument(dependencies.fileSystem, path);

  if (read.status === "FAILED") {
    return { status: "FAILED", target, path, reason: read.reason };
  }

  // The CLI's own pin: a stale entry in either key must show up, not hide behind it.
  const lookup = findPluginEntry(read.document, JEVGUARD_PLUGIN_ENTRY, JEVGUARD_PLUGIN_SPEC);

  switch (lookup.status) {
    case "FOUND":
      return {
        status: "REGISTERED",
        target,
        path,
        pin: pluginVersionOf(lookup.spec),
        legacy: lookup.legacy,
        spec: lookup.spec,
        specs: findPluginEntries(read.document, JEVGUARD_PLUGIN_ENTRY).map((match) => match.spec),
      };
    case "ABSENT":
      return { status: "NOT_REGISTERED", target, path };
    case "INVALID_SHAPE":
      return { status: "FAILED", target, path, reason: "INVALID_CONFIG_SHAPE" };
  }
}
