import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const PURE_DIRECTORIES = ["hook-event", "acquisition", "turn"];
const IO_DIRECTORIES = ["capture", "hook"];
const PURE_FORBIDDEN =
  /^(node:|@opencode-ai\/|@jevguard\/(opencode-adapter|node-infra|plugin|testkit)($|\/)|bun($|:))/;
const IO_FORBIDDEN =
  /^(@opencode-ai\/|@jevguard\/(opencode-adapter|node-infra|plugin|testkit)($|\/)|bun($|:))/;
const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const FORBIDDEN_OUTPUT = /\bconsole\.|process\.(stdout|stderr)/;

function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) return sourceFiles(path);

    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function filesOf(directories: readonly string[]): readonly string[] {
  return directories.flatMap((name) => sourceFiles(join(SOURCE_ROOT, name)));
}

function forbiddenImports(path: string, forbidden: RegExp): readonly string[] {
  const text = readFileSync(path, "utf8");
  const specifiers = [...text.matchAll(IMPORT_SPECIFIER)].map(
    (match) => match[1] ?? match[2] ?? "",
  );

  return specifiers
    .filter((specifier) => forbidden.test(specifier))
    .map((specifier) => `${path}: ${specifier}`);
}

describe("claude-code-adapter package boundary", () => {
  test("the pure core imports no Node, OpenCode, sibling adapter, plugin or testkit module", () => {
    const files = filesOf(PURE_DIRECTORIES);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => forbiddenImports(file, PURE_FORBIDDEN))).toEqual([]);
  });

  test("capture and hook only add Node builtins", () => {
    const files = filesOf(IO_DIRECTORIES);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => forbiddenImports(file, IO_FORBIDDEN))).toEqual([]);
  });

  test("capture and hook never write to the console, stdout or stderr", () => {
    const offenders = filesOf(IO_DIRECTORIES).filter((file) =>
      FORBIDDEN_OUTPUT.test(readFileSync(file, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  test("the package root does not re-export capture or hook", () => {
    const index = readFileSync(join(SOURCE_ROOT, "index.ts"), "utf8");

    expect(index).not.toMatch(/capture|hook\//);
  });
});
