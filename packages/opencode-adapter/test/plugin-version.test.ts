import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JEVGUARD_PLUGIN_ENTRY, JEVGUARD_PLUGIN_SPEC, JEVGUARD_PLUGIN_VERSION } from "../src/index";

const PLUGIN_MANIFEST = join(import.meta.dirname, "..", "..", "plugin", "package.json");

describe("pinned plugin version", () => {
  test("matches the plugin package the CLI registers", async () => {
    const manifest = JSON.parse(await readFile(PLUGIN_MANIFEST, "utf8")) as {
      readonly name: string;
      readonly version: string;
    };

    expect(manifest.name).toBe(JEVGUARD_PLUGIN_ENTRY);
    expect(manifest.version).toBe(JEVGUARD_PLUGIN_VERSION);
  });

  test("names the package and the pinned version", () => {
    expect(JEVGUARD_PLUGIN_SPEC).toBe(`${JEVGUARD_PLUGIN_ENTRY}@${JEVGUARD_PLUGIN_VERSION}`);
  });
});
