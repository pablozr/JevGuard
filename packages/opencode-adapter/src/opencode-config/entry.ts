import type { PluginEntryLookup, PluginEntryMutation } from "./types";

export const JEVGUARD_PLUGIN_ENTRY = "@pablozrrrr/jevguard";

/**
 * The plugin release this CLI was built against. `setup` and `install` write the pinned
 * spec so OpenCode resolves that release instead of `@latest`; a test keeps it equal to
 * `packages/plugin/package.json`.
 */
export const JEVGUARD_PLUGIN_VERSION = "0.4.1";

/** The entry written to `opencode.json`: the package name with its pinned version. */
export const JEVGUARD_PLUGIN_SPEC = `${JEVGUARD_PLUGIN_ENTRY}@${JEVGUARD_PLUGIN_VERSION}`;

const CONFIG_SCHEMA_URL = "https://opencode.ai/config.json";

/** The OpenCode 2.x plugin list key. */
const PLUGINS_KEY = "plugins";

/** The 1.x key, still read (the host normalizes it) but never added to. */
const LEGACY_PLUGIN_KEY = "plugin";

/** Empty config document used when the target file does not exist yet. */
export function createDefaultConfigDocument(): Readonly<Record<string, unknown>> {
  return { $schema: CONFIG_SCHEMA_URL };
}

type PluginListEntry = string | { readonly package: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginList(value: unknown): value is PluginListEntry[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string" || (isPlainObject(item) && typeof item.package === "string"),
    )
  );
}

function specOf(value: PluginListEntry): string {
  return typeof value === "string" ? value : value.package;
}

/** The package name of a spec, dropping the `@version` suffix when present. */
export function pluginPackageOf(spec: string): string {
  const separator = spec.lastIndexOf("@");

  return separator > 0 ? spec.slice(0, separator) : spec;
}

/** The pinned version of a spec, or `null` when it carries none (resolves to `@latest`). */
export function pluginVersionOf(spec: string): string | null {
  const separator = spec.lastIndexOf("@");

  return separator > 0 ? spec.slice(separator + 1) : null;
}

function isEntryFor(value: PluginListEntry, entry: string): boolean {
  return pluginPackageOf(specOf(value)) === entry;
}

/** Read-only view of the JevGuard entry in a parsed `opencode.json` document. */
export function findPluginEntry(document: unknown, entry: string): PluginEntryLookup {
  if (!isPlainObject(document)) {
    return { status: "INVALID_SHAPE" };
  }

  const existing = document[PLUGINS_KEY] ?? [];
  const legacy = document[LEGACY_PLUGIN_KEY] ?? [];

  if (!isPluginList(existing) || !isPluginList(legacy)) {
    return { status: "INVALID_SHAPE" };
  }

  const inPlugins = existing.find((value) => isEntryFor(value, entry));

  if (inPlugins !== undefined) {
    return { status: "FOUND", spec: specOf(inPlugins), legacy: false };
  }

  const inLegacy = legacy.find((value) => isEntryFor(value, entry));

  if (inLegacy !== undefined) {
    return { status: "FOUND", spec: specOf(inLegacy), legacy: true };
  }

  return { status: "ABSENT" };
}

function pinned(value: PluginListEntry, spec: string): PluginListEntry {
  return typeof value === "string" ? spec : { ...value, package: spec };
}

/**
 * Adds the JevGuard entry to the `plugins` list of a parsed `opencode.json` document
 * without mutating the input. It preserves every other key and entry, and refuses a
 * list that is not an array of package strings or `{ package }` objects rather than
 * clobbering it.
 *
 * When the package is registered with another spec (unpinned or another version), the
 * entry is rewritten in place where it already lives, so the host resolves the pinned
 * release instead of `@latest`. A legacy `plugin` entry is updated in place and never
 * moved to `plugins`, so the plugin is not listed twice.
 */
export function addPluginEntry(document: unknown, spec: string): PluginEntryMutation {
  const lookup = findPluginEntry(document, pluginPackageOf(spec));

  if (lookup.status === "INVALID_SHAPE") {
    return { status: "INVALID_SHAPE" };
  }

  if (!isPlainObject(document)) {
    return { status: "INVALID_SHAPE" };
  }

  if (lookup.status === "ABSENT") {
    return addToPlugins(document, spec);
  }

  if (lookup.spec === spec) {
    return { status: "PRESENT" };
  }

  return {
    status: "REPINNED",
    from: lookup.spec,
    document: replaceEntry(document, lookup.legacy, spec),
  };
}

function addToPlugins(document: Record<string, unknown>, spec: string): PluginEntryMutation {
  const existing = (document[PLUGINS_KEY] ?? []) as PluginListEntry[];

  return {
    status: "ADDED",
    document: { ...document, [PLUGINS_KEY]: [...existing, spec] },
  };
}

function replaceEntry(
  document: Record<string, unknown>,
  legacy: boolean,
  spec: string,
): Readonly<Record<string, unknown>> {
  const key = legacy ? LEGACY_PLUGIN_KEY : PLUGINS_KEY;
  const list = document[key] as PluginListEntry[];
  const packageName = pluginPackageOf(spec);

  return {
    ...document,
    [key]: list.map((value) => (isEntryFor(value, packageName) ? pinned(value, spec) : value)),
  };
}
