import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../../..");
const PLUGIN_DIR = join(REPO_ROOT, "packages", "plugin");
const DIST_DIR = join(PLUGIN_DIR, "dist");
const BUILD_SCRIPT = join(PLUGIN_DIR, "scripts", "build-artifact.ts");
const PACK_SCRIPT = join(PLUGIN_DIR, "scripts", "pack-artifact.ts");

const BUILD_SENTINEL_VARIABLE = "JEVGUARD_ARTIFACT_BUILD_SENTINEL";
const BUILD_SENTINEL_VALUE = "JEVGUARD_ARTIFACT_BUILD_SENTINEL_7f3c9d2a";

const EXPECTED_DIST_FILES = ["LICENSE", "README.md", "cli/main.js", "index.js", "package.json"];
const EXPECTED_ARCHIVE_FILES = EXPECTED_DIST_FILES.map((file) => `package/${file}`).sort();
const EXPECTED_RUNTIME_DEPENDENCIES = {
  "@inquirer/password": "^5.2.2",
  "@napi-rs/keyring": "2.1.0",
  "@typesafe-ai/sdk": "0.6.0",
  yaml: "2.9.1",
};
const FORBIDDEN_DEPENDENCIES = [
  "@jevguard/core",
  "@jevguard/opencode-adapter",
  "@opencode-ai/plugin",
  "@opencode-ai/sdk",
];

const INSTALL_TIMEOUT = 300_000;

interface ArtifactManifest {
  readonly private?: boolean;
  readonly type?: string;
  readonly main?: string;
  readonly exports?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
}

interface RootManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

let tempRoot = "";
let tarballPath = "";
let extractedDir = "";
let consumerDir = "";

function listFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...listFiles(root, relative));
    } else {
      files.push(relative);
    }
  }

  return [...files].sort();
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function buildAndPack(): void {
  execFileSync("bun", [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, [BUILD_SENTINEL_VARIABLE]: BUILD_SENTINEL_VALUE },
    stdio: "pipe",
  });

  const packDir = join(tempRoot, "packed");

  execFileSync("bun", [PACK_SCRIPT, "--destination", packDir], { cwd: REPO_ROOT, stdio: "pipe" });

  const archives = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  const archive = archives[0];

  if (archives.length !== 1 || archive === undefined) {
    throw new Error(`expected exactly one packed artifact in ${packDir}`);
  }

  tarballPath = join(packDir, archive);
  extractedDir = join(tempRoot, "extracted");
  mkdirSync(extractedDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractedDir], { stdio: "pipe" });
}

function installIntoCleanConsumer(): void {
  consumerDir = join(tempRoot, "consumer");
  mkdirSync(consumerDir, { recursive: true });
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      { name: "jevguard-artifact-consumer", private: true, type: "module" },
      null,
      2,
    )}\n`,
  );

  execFileSync("bun", ["add", tarballPath, "--no-save", "--prefer-offline"], {
    cwd: consumerDir,
    stdio: "pipe",
    timeout: INSTALL_TIMEOUT,
  });
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "jevguard-artifact-"));

  buildAndPack();
  installIntoCleanConsumer();
}, INSTALL_TIMEOUT);

afterAll(() => {
  if (tempRoot !== "") {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe("local package artifact", () => {
  test("builds a dist containing only the runtime allowlist", () => {
    expect(listFiles(DIST_DIR)).toEqual(EXPECTED_DIST_FILES);
  });

  test("packs only the runtime allowlist into the archive", () => {
    const listed = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .sort();

    expect(listed).toEqual(EXPECTED_ARCHIVE_FILES);
  });

  test("declares no workspace or type-only dependencies in the packed manifest", () => {
    const manifest = readJson<ArtifactManifest>(join(extractedDir, "package", "package.json"));

    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe("module");
    expect(manifest.dependencies).toEqual(EXPECTED_RUNTIME_DEPENDENCIES);
    expect(manifest.main).toBe("./index.js");
    expect(manifest.exports).toEqual({ ".": "./index.js" });
    expect(manifest.bin).toEqual({ jevguard: "./cli/main.js" });
    expect(manifest.engines?.bun).toBeDefined();

    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain("workspace:");

    for (const dependency of FORBIDDEN_DEPENDENCIES) {
      expect(serialized).not.toContain(dependency);
    }
  });

  test("does not embed build-process environment values", () => {
    const bundled = [
      readFileSync(join(DIST_DIR, "index.js"), "utf8"),
      readFileSync(join(DIST_DIR, "cli", "main.js"), "utf8"),
      readFileSync(join(extractedDir, "package", "index.js"), "utf8"),
      readFileSync(join(extractedDir, "package", "cli", "main.js"), "utf8"),
    ];

    for (const content of bundled) {
      expect(content).not.toContain(BUILD_SENTINEL_VALUE);
    }
  });

  test("installs in a clean consumer and imports exactly the plugin export", () => {
    const importCheckPath = join(consumerDir, "import-check.mjs");

    writeFileSync(
      importCheckPath,
      [
        'import * as module from "@jevguard/plugin";',
        "const names = Object.keys(module).sort();",
        "console.log(JSON.stringify({ names, type: typeof module.JevGuardPlugin }));",
        "",
      ].join("\n"),
    );

    const output = execFileSync("bun", [importCheckPath], {
      cwd: consumerDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(output) as {
      readonly names: readonly string[];
      readonly type: string;
    };

    expect(result.names).toEqual(["JevGuardPlugin"]);
    expect(result.type).toBe("function");
  });

  test("runs the installed CLI without resolution errors", () => {
    const result = spawnSync("bun", ["run", "jevguard"], { cwd: consumerDir, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: jevguard login");
    expect(result.stderr).not.toMatch(/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/);
  });

  test("exposes the artifact workflow through root scripts", () => {
    const manifest = readJson<RootManifest>(join(REPO_ROOT, "package.json"));

    expect(manifest.scripts?.["artifact:build"]).toBe(
      "bun packages/plugin/scripts/build-artifact.ts",
    );
    expect(manifest.scripts?.["artifact:pack"]).toBe(
      "bun packages/plugin/scripts/pack-artifact.ts",
    );
  });
});
