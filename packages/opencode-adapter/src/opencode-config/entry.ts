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

interface EntryOccurrence {
  readonly spec: string;
  readonly legacy: boolean;
}

/** Every entry of the package, in `plugins` first and then the legacy `plugin` key. */
function occurrencesOf(
  document: Record<string, unknown>,
  entry: string,
): readonly EntryOccurrence[] {
  const existing = (document[PLUGINS_KEY] ?? []) as PluginListEntry[];
  const legacy = (document[LEGACY_PLUGIN_KEY] ?? []) as PluginListEntry[];

  return [
    ...existing
      .filter((value) => isEntryFor(value, entry))
      .map((value) => ({
        spec: specOf(value),
        legacy: false,
      })),
    ...legacy
      .filter((value) => isEntryFor(value, entry))
      .map((value) => ({
        spec: specOf(value),
        legacy: true,
      })),
  ];
}

/**
 * Read-only view of the JevGuard entry in a parsed `opencode.json` document.
 *
 * With `expectedSpec`, an occurrence that diverges from it wins over one that matches,
 * even when both lists register the package: the host reads `plugins` and the legacy
 * `plugin` key alike, so a stale entry must not hide behind a current one.
 */
export function findPluginEntry(
  document: unknown,
  entry: string,
  expectedSpec?: string,
): PluginEntryLookup {
  if (!isPlainObject(document)) {
    return { status: "INVALID_SHAPE" };
  }

  const existing = document[PLUGINS_KEY] ?? [];
  const legacy = document[LEGACY_PLUGIN_KEY] ?? [];

  if (!isPluginList(existing) || !isPluginList(legacy)) {
    return { status: "INVALID_SHAPE" };
  }

  const occurrences = occurrencesOf(document, entry);
  const found = occurrences.find((occurrence) => occurrence.spec !== expectedSpec);

  if (found !== undefined) {
    return { status: "FOUND", spec: found.spec, legacy: found.legacy };
  }

  const [first] = occurrences;

  return first === undefined
    ? { status: "ABSENT" }
    : { status: "FOUND", spec: first.spec, legacy: first.legacy };
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
 * When the package is registered with another spec (unpinned or another version), every
 * occurrence is rewritten in place, so the host resolves the pinned release instead of
 * `@latest` and a stale entry in the other key cannot survive. A legacy `plugin` entry
 * is updated in place and never moved to `plugins`, so the plugin is not listed twice.
 */
export function addPluginEntry(document: unknown, spec: string): PluginEntryMutation {
  const lookup = findPluginEntry(document, pluginPackageOf(spec), spec);

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
    document: repinEverywhere(document, spec),
  };
}

function addToPlugins(document: Record<string, unknown>, spec: string): PluginEntryMutation {
  const existing = (document[PLUGINS_KEY] ?? []) as PluginListEntry[];

  return {
    status: "ADDED",
    document: { ...document, [PLUGINS_KEY]: [...existing, spec] },
  };
}

/** Re-pins every occurrence of the package; a key the document does not have stays out. */
function repinEverywhere(
  document: Record<string, unknown>,
  spec: string,
): Readonly<Record<string, unknown>> {
  const packageName = pluginPackageOf(spec);
  const repinned = (list: PluginListEntry[]): PluginListEntry[] =>
    list.map((value) => (isEntryFor(value, packageName) ? pinned(value, spec) : value));
  const result: Record<string, unknown> = { ...document };

  for (const key of [PLUGINS_KEY, LEGACY_PLUGIN_KEY]) {
    if (Array.isArray(result[key])) {
      result[key] = repinned(result[key] as PluginListEntry[]);
    }
  }

  return result;
}
