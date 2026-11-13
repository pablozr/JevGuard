import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const FORBIDDEN =
  /^(@opencode(-ai)?\/|@jevguard\/(plugin|claude-code-adapter|testkit)($|\/)|bun($|:))/;
const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) return sourceFiles(path);

    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function forbiddenImports(path: string): readonly string[] {
  const text = readFileSync(path, "utf8");
  const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map(
    (match) => match[1] ?? match[2] ?? "",
  );

  return specifiers
    .filter((specifier) => FORBIDDEN.test(specifier))
    .map((specifier) => `${path}: ${specifier}`);
}

describe("cli package boundary", () => {
  test("imports no host SDK, runtime plugin or host-internal adapter", () => {
    const files = sourceFiles(SOURCE_ROOT);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(forbiddenImports)).toEqual([]);
  });

  test("the forbidden pattern matches host SDKs but not the CLI subpath", () => {
    expect(FORBIDDEN.test("@opencode-ai/sdk")).toBe(true);
    expect(FORBIDDEN.test("@jevguard/plugin")).toBe(true);
    expect(FORBIDDEN.test("@jevguard/opencode-adapter/cli")).toBe(false);
  });
});
