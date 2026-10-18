import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const CATALOG_PATH = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
const TEMPLATE_DIR = join(PACKAGE_DIR, "artifact");

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;
const FORBIDDEN_TEXT = /apiKey|token|TYPESAFE_API_KEY/;
const FORBIDDEN_ENTRY_FIELDS = ["version", "hooks", "headers", "headersHelper"];

interface CatalogEntry {
  readonly name?: string;
  readonly source?: {
    readonly source?: string;
    readonly package?: string;
    readonly version?: string;
  };
}

interface Catalog {
  readonly name?: string;
  readonly owner?: { readonly name?: string };
  readonly plugins?: readonly CatalogEntry[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

describe("claude code marketplace catalog", () => {
  const catalogText = readFileSync(CATALOG_PATH, "utf8");
  const catalog = JSON.parse(catalogText) as Catalog;
  const manifest = readJson<{ name?: string; version?: string }>(
    join(TEMPLATE_DIR, "package.json"),
  );
  const plugin = readJson<{ name?: string; version?: string }>(join(TEMPLATE_DIR, "plugin.json"));
  const [entry] = catalog.plugins ?? [];

  test("names the marketplace and its owner", () => {
    expect(catalog.name).toBe("jevguard");
    expect(catalog.owner?.name).toBeTruthy();
  });

  test("lists exactly the jevguard plugin", () => {
    expect(catalog.plugins).toHaveLength(1);
    expect(entry?.name).toBe(plugin.name);
  });

  test("installs the artifact package from npm at the exact released version", () => {
    expect(entry?.source?.source).toBe("npm");
    expect(entry?.source?.package).toBe(manifest.name);
    expect(entry?.source?.version).toMatch(EXACT_SEMVER);
    expect(manifest.version).toMatch(EXACT_SEMVER);
    expect(plugin.version).toMatch(EXACT_SEMVER);
    expect(entry?.source?.version).toBe(manifest.version);
    expect(plugin.version).toBe(manifest.version);
  });

  test("declares the version only in the source and carries no hooks or headers", () => {
    for (const field of FORBIDDEN_ENTRY_FIELDS) {
      expect(entry).not.toHaveProperty(field);
    }
  });

  test("contains no credential material", () => {
    expect(catalogText).not.toMatch(FORBIDDEN_TEXT);
  });
});
