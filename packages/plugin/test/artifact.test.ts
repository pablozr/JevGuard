import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

const PLUGIN_PACKAGE_NAME = "@pablozrrrr/jevguard";
const PLUGIN_VERSION = "0.1.0";
const SKILL_PACKED_PREFIX = "skills/jevguard-rules";
const EXPECTED_DIST_FILES = [
  "LICENSE",
  "README.md",
  "cli/main.js",
  "index.js",
  "package.json",
  `${SKILL_PACKED_PREFIX}/SKILL.md`,
  `${SKILL_PACKED_PREFIX}/validate-rules.js`,
  "tui/index.js",
];
const EXPECTED_ARCHIVE_FILES = EXPECTED_DIST_FILES.map((file) => `package/${file}`).sort();
const EXPECTED_PACKED_FILES = [
  "index.js",
  "tui/index.js",
  "cli/main.js",
  "README.md",
  "LICENSE",
  `${SKILL_PACKED_PREFIX}/SKILL.md`,
  `${SKILL_PACKED_PREFIX}/validate-rules.js`,
];
const EXPECTED_EXPORTS = { ".": "./index.js", "./tui": "./tui/index.js" };
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
const EXPECTED_REPOSITORY = {
  type: "git",
  url: "git+https://github.com/pablozr/JevGuard.git",
  directory: "packages/plugin",
};
const EXPECTED_HOMEPAGE = "https://github.com/pablozr/JevGuard#readme";
const EXPECTED_BUGS = { url: "https://github.com/pablozr/JevGuard/issues" };
const EXPECTED_ENGINES = { bun: ">=1.1.0", opencode: ">=1.18.31 <2" };
const EXPECTED_PUBLISH_CONFIG = { access: "public", registry: "https://registry.npmjs.org" };

const LOCAL_SHIM = 'export { JevGuardPlugin } from "@pablozrrrr/jevguard";\n';
const LOCAL_TUI_SHIM = 'export { default } from "@pablozrrrr/jevguard/tui";\n';
const SHIM_IMPORT_CHECK = [
  'import * as module from "./jevguard";',
  "const names = Object.keys(module).sort();",
  "console.log(JSON.stringify({ names, type: typeof module.JevGuardPlugin }));",
  "",
].join("\n");

const TUI_SHIM_IMPORT_CHECK = [
  'import plugin from "./jevguard-tui";',
  "console.log(JSON.stringify({ id: plugin.id, type: typeof plugin.tui, server: plugin.server ?? null }));",
  "",
].join("\n");

const CONFIG_HOOK_CHECK = [
  'import { JevGuardPlugin } from "./jevguard";',
  "const hooks = await JevGuardPlugin({ client: {}, worktree: process.cwd() });",
  "const config = {};",
  "await hooks.config(config);",
  "console.log(JSON.stringify(config));",
  "",
].join("\n");

const VALID_SKILL_DOCUMENT = [
  "## ARCH-100",
  "",
  "severity: warning",
  "scope: src/**",
  "",
  "### Rule",
  "",
  "Keep changes under src readable.",
  "",
  "### Violation",
  "",
  "The change adds unnecessary complexity.",
  "",
].join("\n");

const INVALID_SKILL_DOCUMENT = [
  "## BROKEN-100",
  "",
  "### Rule",
  "",
  "Missing severity metadata.",
  "",
  "### Violation",
  "",
  "The change violates the rule.",
  "",
].join("\n");

const INSTALL_TIMEOUT = 300_000;

const PUBLISH_CHECK_SCRIPT =
  "bun packages/plugin/scripts/build-artifact.ts && npm publish --dry-run ./packages/plugin/dist --access public";

interface ArtifactManifest {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly license?: string;
  readonly type?: string;
  readonly main?: string;
  readonly exports?: Readonly<Record<string, string>>;
  readonly bin?: Readonly<Record<string, string>>;
  readonly files?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly repository?: Readonly<Record<string, string>>;
  readonly homepage?: string;
  readonly bugs?: Readonly<Record<string, string>>;
  readonly keywords?: readonly string[];
  readonly publishConfig?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly scripts?: Readonly<Record<string, string>>;
}

interface RootManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

let tempRoot = "";
let tarballPath = "";
let extractedDir = "";
let opencodeDir = "";
let pluginsDir = "";

function listFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) {
      files.push(...listFiles(root, relativePath));
    } else {
      files.push(relativePath);
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

/**
 * Mirrors the supported pre-publication flow: the tarball is installed into the
 * consumer's `.opencode` directory and loaded through a local plugin shim, because
 * OpenCode resolves a bare `opencode.json` plugin entry from the registry or cache,
 * not from the consumer's `node_modules`.
 */
function installLocalArtifact(): void {
  opencodeDir = join(tempRoot, "consumer", ".opencode");
  pluginsDir = join(opencodeDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });

  execFileSync("bun", ["add", tarballPath], {
    cwd: opencodeDir,
    stdio: "pipe",
    timeout: INSTALL_TIMEOUT,
  });

  writeFileSync(join(pluginsDir, "jevguard.ts"), LOCAL_SHIM);
  writeFileSync(join(pluginsDir, "jevguard-tui.ts"), LOCAL_TUI_SHIM);
}

function npmCommand(args: readonly string[]): [string, readonly string[]] {
  if (process.platform === "win32") {
    const command = ["npm", ...args].join(" ");

    return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", command]];
  }

  return ["npm", [...args]];
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

function packedValidatorPath(): string {
  return join(extractedDir, "package", "skills", "jevguard-rules", "validate-rules.js");
}

function runPackedValidator(rulesText: string, name: string): { status: number; stdout: string } {
  const rulesPath = join(tempRoot, name);

  writeFileSync(rulesPath, rulesText, "utf8");

  const result = spawnSync("bun", [packedValidatorPath(), rulesPath], { encoding: "utf8" });

  return { status: result.status ?? -1, stdout: result.stdout ?? "" };
}

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "jevguard-artifact-"));

  buildAndPack();
  installLocalArtifact();
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

  test("packs no TypeScript sources or source maps", () => {
    const listed = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");

    expect(listed.some((entry) => entry.endsWith(".ts"))).toBe(false);
    expect(listed.some((entry) => entry.endsWith(".map"))).toBe(false);
  });

  test("ships a validator that reports valid and invalid candidates without policy content", () => {
    const valid = runPackedValidator(VALID_SKILL_DOCUMENT, "skill-valid.md");

    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ status: "valid", ruleIds: ["ARCH-100"] });

    const invalid = runPackedValidator(INVALID_SKILL_DOCUMENT, "skill-invalid.md");

    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      status: "invalid",
      errorCodes: ["MISSING_SEVERITY"],
    });
    expect(invalid.stdout).not.toContain("Missing severity metadata");
  });

  test("registers the installed skill directory on the live OpenCode config", () => {
    const checkPath = join(pluginsDir, "config-check.ts");

    writeFileSync(checkPath, CONFIG_HOOK_CHECK);

    const output = execFileSync("bun", [checkPath], {
      cwd: pluginsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const config = JSON.parse(output) as {
      readonly skills?: { readonly paths?: readonly string[] };
    };
    const expected = join(
      opencodeDir,
      "node_modules",
      PLUGIN_PACKAGE_NAME,
      "skills",
      "jevguard-rules",
    );

    expect(config.skills?.paths?.map(toPosix)).toEqual([toPosix(expected)]);
  });

  test("publishes the exact public manifest with only runtime dependencies", () => {
    const manifest = readJson<ArtifactManifest>(join(extractedDir, "package", "package.json"));
    const source = readJson<ArtifactManifest>(join(PLUGIN_DIR, "package.json"));

    expect(manifest.name).toBe(PLUGIN_PACKAGE_NAME);
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.private ?? false).toBe(false);
    expect(manifest.type).toBe("module");
    expect(manifest.description).toBe(source.description);
    expect(manifest.license).toBe("MIT");
    expect(manifest.main).toBe("./index.js");
    expect(manifest.exports).toEqual(EXPECTED_EXPORTS);
    expect(manifest.bin).toEqual({ jevguard: "cli/main.js" });
    expect(manifest.files).toEqual(EXPECTED_PACKED_FILES);
    expect(manifest.engines).toEqual(EXPECTED_ENGINES);
    expect(manifest.repository).toEqual(EXPECTED_REPOSITORY);
    expect(manifest.homepage).toBe(EXPECTED_HOMEPAGE);
    expect(manifest.bugs).toEqual(EXPECTED_BUGS);
    expect(manifest.publishConfig).toEqual(EXPECTED_PUBLISH_CONFIG);
    expect(manifest.dependencies).toEqual(EXPECTED_RUNTIME_DEPENDENCIES);
    expect(manifest.scripts).toBeUndefined();

    const serialized = JSON.stringify(manifest);

    expect(serialized).not.toContain("workspace:");

    for (const dependency of FORBIDDEN_DEPENDENCIES) {
      expect(serialized).not.toContain(dependency);
    }
  });

  test("keeps the Bun shebang on the generated CLI entry", () => {
    const generated = readFileSync(join(DIST_DIR, "cli", "main.js"), "utf8");
    const packed = readFileSync(join(extractedDir, "package", "cli", "main.js"), "utf8");

    expect(generated.startsWith("#!/usr/bin/env bun")).toBe(true);
    expect(packed.startsWith("#!/usr/bin/env bun")).toBe(true);
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

  test("installs the tarball into .opencode without internal or host SDK packages", () => {
    for (const dependency of FORBIDDEN_DEPENDENCIES) {
      expect(existsSync(join(opencodeDir, "node_modules", dependency))).toBe(false);
    }

    const installed = readJson<ArtifactManifest>(
      join(opencodeDir, "node_modules", PLUGIN_PACKAGE_NAME, "package.json"),
    );

    expect(installed.name).toBe(PLUGIN_PACKAGE_NAME);
    expect(installed.version).toBe(PLUGIN_VERSION);
    expect(installed.dependencies).toEqual(EXPECTED_RUNTIME_DEPENDENCIES);
  });

  test("loads the local .opencode plugin shim with Bun from the plugins path", () => {
    const checkPath = join(pluginsDir, "import-check.ts");

    writeFileSync(checkPath, SHIM_IMPORT_CHECK);

    const output = execFileSync("bun", [checkPath], {
      cwd: pluginsDir,
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

  test("loads the packaged TUI target from its default export", () => {
    const checkPath = join(pluginsDir, "tui-import-check.ts");

    writeFileSync(checkPath, TUI_SHIM_IMPORT_CHECK);

    const output = execFileSync("bun", [checkPath], {
      cwd: pluginsDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = JSON.parse(output) as {
      readonly id: string;
      readonly type: string;
      readonly server: null;
    };

    expect(result).toEqual({ id: "jevguard", type: "function", server: null });
  });

  test("runs the installed CLI through the Bun bin mapping from .opencode", () => {
    const result = spawnSync("bun", ["run", "jevguard"], { cwd: opencodeDir, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage: jevguard login");
    expect(result.stderr).not.toMatch(/Cannot find (module|package)|ERR_MODULE_NOT_FOUND/);
  });

  test("validates the dist with npm publish --dry-run without publishing", () => {
    const result = spawnSync(
      ...npmCommand(["publish", "--dry-run", DIST_DIR, "--access", "public"]),
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status).toBe(0);
    expect(output).toContain(`${PLUGIN_PACKAGE_NAME}@${PLUGIN_VERSION}`);
    expect(output).toContain("dry-run");
    expect(output).not.toContain("auto-corrected");
    expect(output).not.toContain("npm warn publish");
  }, 60_000);

  test("exposes the artifact workflow through root scripts", () => {
    const manifest = readJson<RootManifest>(join(REPO_ROOT, "package.json"));

    expect(manifest.scripts?.["artifact:build"]).toBe(
      "bun packages/plugin/scripts/build-artifact.ts",
    );
    expect(manifest.scripts?.["artifact:pack"]).toBe(
      "bun packages/plugin/scripts/pack-artifact.ts",
    );
    expect(manifest.scripts?.["artifact:publish:check"]).toBe(PUBLISH_CHECK_SCRIPT);
  });
});
