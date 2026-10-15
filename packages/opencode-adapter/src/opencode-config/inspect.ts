import { addPluginEntry, JEVGUARD_PLUGIN_ENTRY } from "./entry";
import { resolveConfigPath } from "./paths";
import { readConfigDocument } from "./read-document";
import type { InspectInstallDependencies, InstallInspection } from "./types";

/**
 * Read-only counterpart of `install`: reports whether the JevGuard plugin entry is
 * registered in the target `opencode.json`. It never writes and never throws; every
 * failure maps to a typed reason.
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

  const mutation = addPluginEntry(read.document, JEVGUARD_PLUGIN_ENTRY);

  switch (mutation.status) {
    case "PRESENT":
      return { status: "REGISTERED", target, path };
    case "ADDED":
      return { status: "NOT_REGISTERED", target, path };
    case "INVALID_SHAPE":
      return { status: "FAILED", target, path, reason: "INVALID_CONFIG_SHAPE" };
  }
}
