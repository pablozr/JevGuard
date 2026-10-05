import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const FORBIDDEN_SPECIFIER = /^(@jevguard\/|node:|yaml$|@opencode-ai\/|@typesafe-ai\/|bun($|:))/;
const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function forbiddenImports(path: string): readonly string[] {
  const text = readFileSync(path, "utf8");
  const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map(
    (match) => match[1] ?? match[2] ?? "",
  );

  return specifiers
    .filter((specifier) => FORBIDDEN_SPECIFIER.test(specifier))
    .map((specifier) => `${path}: ${specifier}`);
}

describe("core package boundary", () => {
  test("imports no workspace package, Node, host, transport, or runtime module", () => {
    const files = sourceFiles(SOURCE_ROOT);
    const violations = files.flatMap(forbiddenImports);

    expect(files.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
