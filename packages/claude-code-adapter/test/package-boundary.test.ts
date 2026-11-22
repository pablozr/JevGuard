import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const SOURCE_ROOT = join(import.meta.dirname, "..", "src");
const PURE_DIRECTORIES = ["hook-event", "acquisition", "turn", "presentation"];
const IO_DIRECTORIES = ["capture", "hook"];
const GATE_DIRECTORIES = ["enforce"];
const WORKER_DIRECTORIES = ["worker"];
const PURE_FORBIDDEN =
  /^(node:|@opencode(-ai)?\/|@jevguard\/(opencode-adapter|node-infra|plugin)($|\/)|bun($|:))/;
const IO_FORBIDDEN =
  /^(@opencode(-ai)?\/|@jevguard\/(opencode-adapter|node-infra|plugin)($|\/)|bun($|:))/;
const GATE_FORBIDDEN = /^(@opencode(-ai)?\/|@jevguard\/(opencode-adapter|plugin)($|\/)|bun($|:))/;
/**
 * The gate reads the user's file and the review history through two node-infra
 * subpaths that are local only (file system, no keyring, no Jev, no network); every
 * other node-infra entry stays out of it, exactly as it stays out of the hook.
 */
const GATE_NODE_INFRA = /^@jevguard\/node-infra(\/(?!enforce$|history$).*)?$/;
const WORKER_FORBIDDEN = /^(@opencode(-ai)?\/|@jevguard\/(opencode-adapter|plugin)($|\/)|bun($|:))/;
const IMPORT_SPECIFIER = /\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
const FORBIDDEN_OUTPUT = /\bconsole\.|process\.(stdout|stderr)/;
/**
 * The single module allowed to write to stdout: the `Stop` decision that holds a turn
 * when the user enabled enforce (ADR 0022). It uses a synchronous write, never
 * `process.stdout`, and every other hook module stays silent.
 */
const DECISION_WRITER = join(SOURCE_ROOT, "hook", "decision-output.ts");

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
  test("the pure core imports no Node, OpenCode, sibling adapter or plugin module", () => {
    const files = filesOf(PURE_DIRECTORIES);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => forbiddenImports(file, PURE_FORBIDDEN))).toEqual([]);
  });

  test("capture and hook only add Node builtins", () => {
    const files = filesOf(IO_DIRECTORIES);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => forbiddenImports(file, IO_FORBIDDEN))).toEqual([]);
  });

  test("only the worker may import node-infra, and it adds no other host or sibling", () => {
    const files = filesOf(WORKER_DIRECTORIES);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => forbiddenImports(file, WORKER_FORBIDDEN))).toEqual([]);
  });

  test("the enforce gate adds only Node builtins and the local node-infra subpaths", () => {
    const files = filesOf(GATE_DIRECTORIES);

    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => forbiddenImports(file, GATE_FORBIDDEN))).toEqual([]);
    expect(files.flatMap((file) => forbiddenImports(file, GATE_NODE_INFRA))).toEqual([]);
  });

  test("capture, hook, gate and worker never write to the console, stdout or stderr", () => {
    const offenders = filesOf([...IO_DIRECTORIES, ...GATE_DIRECTORIES, ...WORKER_DIRECTORIES])
      .filter((file) => file !== DECISION_WRITER)
      .filter((file) => FORBIDDEN_OUTPUT.test(readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  });

  test("capture and hook never import the worker", () => {
    const offenders = filesOf(IO_DIRECTORIES).flatMap((file) =>
      forbiddenImports(file, /^\.\.?\/(\.\.\/)?worker($|\/)/),
    );

    expect(offenders).toEqual([]);
  });

  test("presentation imports acquisition as types only, core as pure values and no I/O sibling", () => {
    const files = filesOf(["presentation"]);
    const valueImport = /\bimport\s+(?!type\b)[^;]*?from\s+["']\.\.\/acquisition["']/;

    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => valueImport.test(readFileSync(file, "utf8")))).toEqual([]);
    expect(
      files.flatMap((file) => forbiddenImports(file, /^\.\.\/(worker|capture|hook)($|\/)/)),
    ).toEqual([]);
  });

  test("the package root does not re-export capture or hook", () => {
    const index = readFileSync(join(SOURCE_ROOT, "index.ts"), "utf8");

    expect(index).not.toMatch(/capture|hook\//);
  });

  test("forbids the real OpenCode SDK specifier", () => {
    for (const forbidden of [PURE_FORBIDDEN, IO_FORBIDDEN, WORKER_FORBIDDEN]) {
      expect(forbidden.test("@opencode/plugin")).toBe(true);
      expect(forbidden.test("@opencode-ai/sdk")).toBe(true);
    }
  });
});
