import type { PluginEntryMutation } from "./types";

export const JEVGUARD_PLUGIN_ENTRY = "@pablozrrrr/jevguard";

const CONFIG_SCHEMA_URL = "https://opencode.ai/config.json";

/** Empty config document used when the target file does not exist yet. */
export function createDefaultConfigDocument(): Readonly<Record<string, unknown>> {
  return { $schema: CONFIG_SCHEMA_URL };
}

/**
 * Adds the JevGuard entry to a parsed `opencode.json` document without mutating the
 * input. It preserves every other key and every existing `plugin` entry, and refuses
 * an existing `plugin` value that is not an array of strings rather than clobbering it.
 */
export function addPluginEntry(document: unknown, entry: string): PluginEntryMutation {
  if (!isPlainObject(document)) {
    return { status: "INVALID_SHAPE" };
  }

  const existing = document.plugin;

  if (existing === undefined) {
    return { status: "ADDED", document: { ...document, plugin: [entry] } };
  }

  if (!isStringArray(existing)) {
    return { status: "INVALID_SHAPE" };
  }

  if (existing.some((value) => isPluginEntryFor(value, entry))) {
    return { status: "PRESENT" };
  }

  return { status: "ADDED", document: { ...document, plugin: [...existing, entry] } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPluginEntryFor(value: string, entry: string): boolean {
  return value === entry || value.startsWith(`${entry}@`);
}
