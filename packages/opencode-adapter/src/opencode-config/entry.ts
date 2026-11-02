import type { PluginEntryMutation } from "./types";

export const JEVGUARD_PLUGIN_ENTRY = "@pablozrrrr/jevguard";

const CONFIG_SCHEMA_URL = "https://opencode.ai/config.json";

/** The OpenCode 2.x plugin list key. */
const PLUGINS_KEY = "plugins";

/** The 1.x key, still read (the host normalizes it) but never written. */
const LEGACY_PLUGIN_KEY = "plugin";

/** Empty config document used when the target file does not exist yet. */
export function createDefaultConfigDocument(): Readonly<Record<string, unknown>> {
  return { $schema: CONFIG_SCHEMA_URL };
}

/**
 * Adds the JevGuard entry to the `plugins` list of a parsed `opencode.json` document
 * without mutating the input. It preserves every other key and entry, and refuses a
 * list that is not an array of package strings or `{ package }` objects rather than
 * clobbering it. An entry already in the legacy `plugin` list counts as present.
 */
export function addPluginEntry(document: unknown, entry: string): PluginEntryMutation {
  if (!isPlainObject(document)) {
    return { status: "INVALID_SHAPE" };
  }

  const existing = document[PLUGINS_KEY] ?? [];
  const legacy = document[LEGACY_PLUGIN_KEY] ?? [];

  if (!isPluginList(existing) || !isPluginList(legacy)) {
    return { status: "INVALID_SHAPE" };
  }

  if ([...existing, ...legacy].some((value) => isPluginEntryFor(value, entry))) {
    return { status: "PRESENT" };
  }

  return { status: "ADDED", document: { ...document, [PLUGINS_KEY]: [...existing, entry] } };
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

function isPluginEntryFor(value: PluginListEntry, entry: string): boolean {
  const spec = typeof value === "string" ? value : value.package;

  return spec === entry || spec.startsWith(`${entry}@`);
}
