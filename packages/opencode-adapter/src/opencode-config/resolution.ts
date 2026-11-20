import { join } from "node:path";
import { pluginPackageOf, pluginVersionOf } from "./entry";

/** Read-only port over the host's plugin cache; `null` means the path is absent. */
export interface PluginCacheFileSystem {
  readDirectory(path: string): Promise<readonly string[] | null>;
  readFile(path: string): Promise<string | null>;
}

export type PluginResolutionReason = "READ_FAILURE" | "INCOMPLETE_INSTALL" | "PACKAGE_MISMATCH";

/**
 * What the host cache proves about one registered entry. It never carries a cache path:
 * a local directory stays out of the report.
 */
export type PluginResolution =
  | { readonly status: "RESOLVED"; readonly package: string; readonly version: string }
  | {
      readonly status: "VERSION_MISMATCH";
      readonly package: string;
      readonly version: string;
      readonly pin: string;
    }
  | { readonly status: "NOT_CACHED"; readonly package: string }
  | {
      readonly status: "UNREADABLE";
      readonly package: string;
      readonly reason: PluginResolutionReason;
    }
  | { readonly status: "UNSUPPORTED"; readonly package: string };

export interface PluginResolutionDependencies {
  /** `~/.cache/opencode/npm`, the directory the host installs package plugins into. */
  readonly cacheRoot: string;
  /** The entry as written in `opencode.json`, e.g. `@pablozrrrr/jevguard@0.4.1`. */
  readonly spec: string;
  readonly fileSystem: PluginCacheFileSystem;
}

interface PluginManifest {
  readonly name: string;
  readonly version: string;
}

/**
 * Proves that the host can resolve a package plugin without starting the host or calling
 * a model: it reads the manifest the host's installer left in its cache. A registry spec
 * is required; a `file:`, Git or URL entry cannot be proven here and says so.
 *
 * The answer is one of the states the doctor prints. An entry that is not in the cache —
 * registered but never loaded, or an install that did not finish — is `NOT_CACHED`, never
 * a success.
 */
export async function resolveCachedPlugin(
  dependencies: PluginResolutionDependencies,
): Promise<PluginResolution> {
  const packageName = pluginPackageOf(dependencies.spec);

  if (!isRegistrySpec(dependencies.spec)) {
    return { status: "UNSUPPORTED", package: packageName };
  }

  const installs = await readInstallDirectories(dependencies, cacheDirNameOf(dependencies.spec));

  if (installs === "READ_FAILURE") {
    return { status: "UNREADABLE", package: packageName, reason: "READ_FAILURE" };
  }

  const newest = installs.filter(isTimestamp).sort(compareTimestamps).at(-1);

  if (newest === undefined) {
    return { status: "NOT_CACHED", package: packageName };
  }

  const manifest = await readPackageManifest(
    dependencies.fileSystem,
    join(dependencies.cacheRoot, cacheDirNameOf(dependencies.spec), newest),
    packageName,
  );

  if (manifest === "READ_FAILURE") {
    return { status: "UNREADABLE", package: packageName, reason: "READ_FAILURE" };
  }

  if (manifest === "INCOMPLETE_INSTALL") {
    return { status: "UNREADABLE", package: packageName, reason: "INCOMPLETE_INSTALL" };
  }

  if (manifest === "PACKAGE_MISMATCH") {
    return { status: "UNREADABLE", package: packageName, reason: "PACKAGE_MISMATCH" };
  }

  const pin = pluginVersionOf(dependencies.spec);

  if (pin !== null && manifest.version !== pin) {
    return { status: "VERSION_MISMATCH", package: packageName, version: manifest.version, pin };
  }

  return { status: "RESOLVED", package: packageName, version: manifest.version };
}

/** The directory the host names for a spec: an unpinned entry resolves to `@latest`. */
export function cacheDirNameOf(spec: string): string {
  return pluginVersionOf(spec) === null ? `${spec}@latest` : spec;
}

/** A spec a package manager can resolve; anything else is checkable only by the host. */
function isRegistrySpec(spec: string): boolean {
  return !/^(file:|git\+|git:|github:|https?:)/i.test(spec);
}

async function readInstallDirectories(
  dependencies: PluginResolutionDependencies,
  cacheDir: string,
): Promise<readonly string[] | "READ_FAILURE"> {
  try {
    return (
      (await dependencies.fileSystem.readDirectory(join(dependencies.cacheRoot, cacheDir))) ?? []
    );
  } catch {
    return "READ_FAILURE";
  }
}

function isTimestamp(name: string): boolean {
  return /^\d+$/.test(name);
}

function compareTimestamps(left: string, right: string): number {
  return Number(left) - Number(right);
}

type ManifestRead = PluginManifest | PluginResolutionReason;

async function readPackageManifest(
  fileSystem: PluginCacheFileSystem,
  installDirectory: string,
  packageName: string,
): Promise<ManifestRead> {
  const path = join(installDirectory, "node_modules", packageName, "package.json");
  const text = await readText(fileSystem, path);

  if (text === "READ_FAILURE") {
    return "READ_FAILURE";
  }

  if (text === null) {
    return "INCOMPLETE_INSTALL";
  }

  const parsed = parseManifest(text);

  if (parsed === null) {
    return "READ_FAILURE";
  }

  return parsed.name === packageName ? parsed : "PACKAGE_MISMATCH";
}

async function readText(
  fileSystem: PluginCacheFileSystem,
  path: string,
): Promise<string | null | "READ_FAILURE"> {
  try {
    return await fileSystem.readFile(path);
  } catch {
    return "READ_FAILURE";
  }
}

function parseManifest(text: string): PluginManifest | null {
  try {
    const parsed: unknown = JSON.parse(text);

    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PluginManifest).name === "string" &&
      typeof (parsed as PluginManifest).version === "string"
    ) {
      return { name: (parsed as PluginManifest).name, version: (parsed as PluginManifest).version };
    }

    return null;
  } catch {
    return null;
  }
}
