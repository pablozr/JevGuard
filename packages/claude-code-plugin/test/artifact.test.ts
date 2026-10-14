import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(TEST_DIR, "..");
const REPO_ROOT = resolve(PACKAGE_DIR, "..", "..");
const DIST_DIR = join(PACKAGE_DIR, "dist");
const BUILD_SCRIPT = join(PACKAGE_DIR, "scripts", "build-artifact.ts");

const SENTINEL_VARIABLE = "JEVGUARD_ARTIFACT_BUILD_SENTINEL";
const SENTINEL_VALUE = "JEVGUARD_CLAUDE_ARTIFACT_SENTINEL_5b1e0c44";
const BUILD_TIMEOUT = 120_000;

const EXPECTED_FILES = [
  ".claude-plugin/plugin.json",
  "LICENSE",
  "hook.js",
  "hooks/hooks.json",
  "hooks/jevguard-ui.js",
  "package-lock.json",
  "package.json",
  "types/index.d.ts",
  "worker.js",
];
const EXPECTED_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "StopFailure",
];
const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];
const FORBIDDEN_HOOK_FIELDS = ["async", "asyncRewake"];
const FORBIDDEN_CONTENT = [
  /fixture/i,
  /sk-[A-Za-z0-9]{20,}/,
  /TYPESAFE_API_KEY\s*[:=]\s*["'][^"']+["']/,
];
const STATIC_KEYRING_IMPORT = /^import [^\n]* from ["']@napi-rs\/keyring["']/m;
const WORKSPACE_IMPORT = /^import [^\n]* from ["']@jevguard\//m;
const MOD_FORBIDDEN_TEXT = /import\(|require\(|node:|process\.|@jevguard\/|napi-rs|typesafe/;
const MOD_FORBIDDEN_CALLS =
  /\$\.(command|tool|agent|http|process|store|turn|audio|settings|mcp)\b|\$\.model\.(?!complete\b)|\$\.prompt\.(?!submit\b)|\$\.session\.(append|send|compact|authorize)|\$\.env\.set|\$\.fs\.(list|stat)|asUser/;

interface HookCommand {
  readonly type?: string;
  readonly command?: string;
  readonly timeout?: number;
}

interface HookGroup {
  readonly matcher?: string;
  readonly hooks?: readonly HookCommand[];
}

interface HooksFile {
  readonly modules?: readonly string[];
  readonly hooks?: Readonly<Record<string, readonly HookGroup[]>>;
}

interface PackageLock {
  readonly name?: string;
  readonly version?: string;
  readonly packages?: Readonly<
    Record<string, { readonly dependencies?: Readonly<Record<string, string>> }>
  >;
}

interface Manifest {
  readonly name?: string;
  readonly version?: string;
  readonly type?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly engines?: Readonly<Record<string, string>>;
}

let scratch = "";

function listFiles(root: string, prefix = ""): string[] {
  const directory = prefix === "" ? root : join(root, prefix);
  const files: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    if (entry.isDirectory()) files.push(...listFiles(root, relative));
    else files.push(relative);
  }

  return files.sort();
}

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(join(DIST_DIR, relative), "utf8")) as T;
}

function runEntry(entry: string, input: string, environment: Record<string, string>) {
  return spawnSync(process.execPath, [join(DIST_DIR, entry)], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...environment },
    timeout: 60_000,
  });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "jevguard-claude-artifact-"));

  execFileSync("bun", [BUILD_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, [SENTINEL_VARIABLE]: SENTINEL_VALUE },
    stdio: "pipe",
  });
}, BUILD_TIMEOUT);

afterAll(() => {
  if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
});

describe("claude code artifact", () => {
  test("ships exactly the allowlisted files", () => {
    expect(listFiles(DIST_DIR)).toEqual(EXPECTED_FILES);
  });

  test("hooks.json registers every handled event without async delivery", () => {
    const { hooks, modules } = readJson<HooksFile>("hooks/hooks.json");

    expect(modules).toEqual(["./jevguard-ui.js"]);

    expect(Object.keys(hooks ?? {}).sort()).toEqual([...EXPECTED_EVENTS].sort());

    for (const [event, groups] of Object.entries(hooks ?? {})) {
      expect(groups).toHaveLength(1);

      const [group] = groups;

      expect(group?.matcher).toBe(TOOL_EVENTS.includes(event) ? "*" : undefined);
      expect(group?.hooks).toHaveLength(1);

      const [command] = group?.hooks ?? [];

      expect(command).toMatchObject({
        type: "command",
        command: `node "\${CLAUDE_PLUGIN_ROOT}/hook.js"`,
        timeout: 30,
      });

      for (const field of FORBIDDEN_HOOK_FIELDS) {
        expect(command).not.toHaveProperty(field);
      }
    }
  });

  test("plugin.json names the plugin and carries no credential configuration", () => {
    const text = readFileSync(join(DIST_DIR, ".claude-plugin", "plugin.json"), "utf8");
    const manifest = JSON.parse(text) as { name?: string };

    expect(manifest.name).toBe("jevguard");
    expect(text).not.toMatch(/userConfig|apiKey|api_key|token/i);
  });

  test("package.json, package-lock.json and plugin.json are consistent", () => {
    const manifest = readJson<Manifest>("package.json");
    const lock = readJson<PackageLock>("package-lock.json");
    const plugin = readJson<{ version?: string }>(".claude-plugin/plugin.json");
    const root = lock.packages?.[""];

    expect(manifest.type).toBe("module");
    expect(manifest.dependencies).toEqual({ "@napi-rs/keyring": "2.1.0" });
    expect(manifest.engines).toEqual({ node: ">=22.13.0" });
    expect(lock.name).toBe(manifest.name);
    expect(lock.version).toBe(manifest.version);
    expect(root?.dependencies).toEqual(manifest.dependencies);
    expect(plugin.version).toBe(manifest.version);
    expect(Object.keys(lock.packages ?? {})).toContain("node_modules/@napi-rs/keyring");
    expect(readFileSync(join(DIST_DIR, "package-lock.json"), "utf8")).not.toContain(
      "hasInstallScript",
    );
  });

  test("the hook never references the keyring and the worker loads it lazily", () => {
    const hook = readFileSync(join(DIST_DIR, "hook.js"), "utf8");
    const worker = readFileSync(join(DIST_DIR, "worker.js"), "utf8");

    expect(hook).not.toMatch(/napi-rs|typesafe/i);
    expect(worker).toContain('await import("@napi-rs/keyring")');
    expect(worker).not.toMatch(STATIC_KEYRING_IMPORT);
    expect(worker).not.toMatch(WORKSPACE_IMPORT);
  });

  test("the UI mod presents to the user and only the opt-in remediation reaches a model or the agent", () => {
    const mod = readFileSync(join(DIST_DIR, "hooks", "jevguard-ui.js"), "utf8");

    expect(mod).toContain("function register(");
    expect(mod).toContain("export {");
    expect(mod).toContain("$.ui.log(");
    expect(mod).toContain("$.fs.read(");
    expect(mod).toContain("$.model.complete(");
    expect(mod).toContain("$.ui.open(");
    expect(mod).toContain("$.prompt.submit(");
    expect(mod).not.toMatch(MOD_FORBIDDEN_TEXT);
    expect(mod).not.toMatch(MOD_FORBIDDEN_CALLS);
  });

  test("contains no build secret, fixture or workspace specifier", () => {
    for (const file of EXPECTED_FILES) {
      const text = readFileSync(join(DIST_DIR, file), "utf8");

      expect(text).not.toContain(SENTINEL_VALUE);
      expect(text).not.toContain("workspace:");

      if (file.endsWith(".js")) {
        for (const pattern of FORBIDDEN_CONTENT) expect(text).not.toMatch(pattern);
      }
    }
  });

  test("hook.js with invalid stdin exits 0 with no stdout and no stderr", () => {
    const result = runEntry("hook.js", "{not json", {
      CLAUDE_PLUGIN_DATA: join(scratch, "hook-data"),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("hook.js without a plugin data directory is silent and exits 0", () => {
    const result = runEntry("hook.js", "", {});

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("worker.js with nothing to review logs one code and exits 0", () => {
    const pluginData = join(scratch, "worker-data");
    const result = runEntry("worker.js", "", { CLAUDE_PLUGIN_DATA: pluginData });
    const logFile = join(pluginData, "claude-code", "worker-log.jsonl");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(logFile)).toBe(true);

    const codes = readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => (JSON.parse(line) as { code: string }).code);

    expect(codes).toEqual(["WORKER_STARTED"]);
  });
});
