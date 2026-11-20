import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ConfirmationPrompt, ConfirmationResult } from "@jevguard/node-infra";
import {
  addPluginEntry,
  checkOpenCodeVersion,
  findPluginEntry,
  createNodeConfigFileSystem,
  install,
  JEVGUARD_PLUGIN_ENTRY,
  JEVGUARD_PLUGIN_SPEC,
  JEVGUARD_PLUGIN_VERSION,
  OPENCODE_ENGINE_RANGE,
  OPENCODE_LATEST_SUPPORTED,
  OPENCODE_PIN_COMMAND,
  pluginPackageOf,
  pluginVersionOf,
  resolveConfigPath,
} from "../src/index";
import type { ConfigFileSystem, InstallDependencies, InstallTarget } from "../src/index";

const CWD = join("C:", "repo");
const HOME = join("C:", "home");
const XDG = resolve("/xdg");

const GLOBAL_PATH = join(HOME, ".config", "opencode", "opencode.json");
const XDG_PATH = join(XDG, "opencode", "opencode.json");
const PROJECT_PATH = join(CWD, "opencode.json");
const JSONC_PATH = join(dirname(GLOBAL_PATH), "opencode.jsonc");
const DEFAULT_DOCUMENT = `${JSON.stringify(
  { $schema: "https://opencode.ai/config.json", plugins: [JEVGUARD_PLUGIN_SPEC] },
  null,
  2,
)}\n`;

class FakeFileSystem implements ConfigFileSystem {
  readonly files = new Map<string, string>();
  readonly writes: Array<{ readonly path: string; readonly contents: string }> = [];
  readonly ensured: string[] = [];
  readError: Error | null = null;
  writeError: Error | null = null;
  existsError: Error | null = null;

  readFile(path: string): Promise<string | null> {
    if (this.readError !== null) {
      return Promise.reject(this.readError);
    }

    return Promise.resolve(this.files.get(path) ?? null);
  }

  fileExists(path: string): Promise<boolean> {
    if (this.existsError !== null) {
      return Promise.reject(this.existsError);
    }

    return Promise.resolve(this.files.has(path));
  }

  writeFile(path: string, contents: string): Promise<void> {
    if (this.writeError !== null) {
      return Promise.reject(this.writeError);
    }

    this.writes.push({ path, contents });
    this.files.set(path, contents);

    return Promise.resolve();
  }

  ensureParentDirectory(path: string): Promise<void> {
    this.ensured.push(path);

    return Promise.resolve();
  }
}

class FakeConfirmation implements ConfirmationPrompt {
  result: ConfirmationResult = { status: "CONFIRMED" };
  readonly messages: string[] = [];

  confirm(message: string): Promise<ConfirmationResult> {
    this.messages.push(message);

    return Promise.resolve(this.result);
  }
}

interface Harness {
  readonly fileSystem: FakeFileSystem;
  readonly confirmation: FakeConfirmation;
  readonly dependencies: InstallDependencies;
}

function harness(target: InstallTarget = "global"): Harness {
  const fileSystem = new FakeFileSystem();
  const confirmation = new FakeConfirmation();

  return {
    fileSystem,
    confirmation,
    dependencies: {
      target,
      confirmation,
      fileSystem,
      cwd: CWD,
      environment: {},
      homedir: HOME,
    },
  };
}

describe("addPluginEntry", () => {
  test("adds the pinned spec when the plugins key is absent", () => {
    const result = addPluginEntry({ $schema: "schema" }, JEVGUARD_PLUGIN_SPEC);

    expect(result).toEqual({
      status: "ADDED",
      document: { $schema: "schema", plugins: [JEVGUARD_PLUGIN_SPEC] },
    });
  });

  test("reports PRESENT only for the exact pinned spec", () => {
    expect(addPluginEntry({ plugins: [JEVGUARD_PLUGIN_SPEC] }, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "PRESENT",
    });
  });

  test("re-pins an unpinned or older entry in place", () => {
    const unpinned = addPluginEntry(
      { plugins: ["other", JEVGUARD_PLUGIN_ENTRY] },
      JEVGUARD_PLUGIN_SPEC,
    );
    const older = addPluginEntry(
      { plugins: [`${JEVGUARD_PLUGIN_ENTRY}@0.3.0`] },
      JEVGUARD_PLUGIN_SPEC,
    );

    expect(unpinned).toEqual({
      status: "REPINNED",
      from: JEVGUARD_PLUGIN_ENTRY,
      document: { plugins: ["other", JEVGUARD_PLUGIN_SPEC] },
    });
    expect(older).toEqual({
      status: "REPINNED",
      from: `${JEVGUARD_PLUGIN_ENTRY}@0.3.0`,
      document: { plugins: [JEVGUARD_PLUGIN_SPEC] },
    });
  });

  test("preserves unknown keys, their order, and existing plugin entries", () => {
    const result = addPluginEntry(
      { $schema: "schema", model: "gpt", plugins: ["other-plugin"] },
      JEVGUARD_PLUGIN_SPEC,
    );

    expect(result.status).toBe("ADDED");

    if (result.status !== "ADDED") {
      throw new Error("expected ADDED");
    }

    expect(Object.keys(result.document)).toEqual(["$schema", "model", "plugins"]);
    expect(result.document.plugins).toEqual(["other-plugin", JEVGUARD_PLUGIN_SPEC]);
  });

  test("refuses a non-object document", () => {
    expect(addPluginEntry(["plugin"], JEVGUARD_PLUGIN_SPEC)).toEqual({ status: "INVALID_SHAPE" });
    expect(addPluginEntry(null, JEVGUARD_PLUGIN_SPEC)).toEqual({ status: "INVALID_SHAPE" });
  });

  test("refuses a plugins value that is not a list of package entries", () => {
    expect(addPluginEntry({ plugins: "x" }, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "INVALID_SHAPE",
    });
    expect(addPluginEntry({ plugins: [42] }, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "INVALID_SHAPE",
    });
    expect(addPluginEntry({ plugin: "x" }, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "INVALID_SHAPE",
    });
  });

  test("re-pins a legacy plugin entry in place without moving it to plugins", () => {
    expect(addPluginEntry({ plugin: [JEVGUARD_PLUGIN_ENTRY] }, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "REPINNED",
      from: JEVGUARD_PLUGIN_ENTRY,
      document: { plugin: [JEVGUARD_PLUGIN_SPEC] },
    });
    expect(addPluginEntry({ plugin: [JEVGUARD_PLUGIN_SPEC] }, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "PRESENT",
    });
  });

  test("re-pins every occurrence across both keys, so a stale entry cannot survive", () => {
    const both = { plugins: [JEVGUARD_PLUGIN_SPEC], plugin: [`${JEVGUARD_PLUGIN_ENTRY}@0.3.0`] };
    const first = addPluginEntry(both, JEVGUARD_PLUGIN_SPEC);

    expect(first).toEqual({
      status: "REPINNED",
      from: `${JEVGUARD_PLUGIN_ENTRY}@0.3.0`,
      document: { plugins: [JEVGUARD_PLUGIN_SPEC], plugin: [JEVGUARD_PLUGIN_SPEC] },
    });

    if (first.status !== "REPINNED") throw new Error("expected REPINNED");

    expect(addPluginEntry(first.document, JEVGUARD_PLUGIN_SPEC)).toEqual({ status: "PRESENT" });
  });

  test("a stale legacy entry is visible even when plugins already has the pinned spec", () => {
    const document = {
      plugins: [JEVGUARD_PLUGIN_SPEC],
      plugin: [`${JEVGUARD_PLUGIN_ENTRY}@0.3.0`],
    };

    expect(findPluginEntry(document, JEVGUARD_PLUGIN_ENTRY, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "FOUND",
      spec: `${JEVGUARD_PLUGIN_ENTRY}@0.3.0`,
      legacy: true,
    });
  });

  test("keeps a package object entry as an object and only updates its package", () => {
    expect(
      addPluginEntry({ plugins: [{ package: JEVGUARD_PLUGIN_SPEC }] }, JEVGUARD_PLUGIN_SPEC),
    ).toEqual({ status: "PRESENT" });

    expect(
      addPluginEntry(
        { plugins: [{ package: JEVGUARD_PLUGIN_ENTRY, extra: true }] },
        JEVGUARD_PLUGIN_SPEC,
      ),
    ).toEqual({
      status: "REPINNED",
      from: JEVGUARD_PLUGIN_ENTRY,
      document: { plugins: [{ package: JEVGUARD_PLUGIN_SPEC, extra: true }] },
    });
  });

  test("writes only to plugins, keeping package objects and the legacy list", () => {
    const document = { plugin: ["other"], plugins: [{ package: "file:/x" }] };

    expect(addPluginEntry(document, JEVGUARD_PLUGIN_SPEC)).toEqual({
      status: "ADDED",
      document: {
        plugin: ["other"],
        plugins: [{ package: "file:/x" }, JEVGUARD_PLUGIN_SPEC],
      },
    });
  });

  test("names the pinned package and version", () => {
    expect(pluginPackageOf(JEVGUARD_PLUGIN_SPEC)).toBe(JEVGUARD_PLUGIN_ENTRY);
    expect(pluginVersionOf(JEVGUARD_PLUGIN_SPEC)).toBe(JEVGUARD_PLUGIN_VERSION);
    expect(pluginVersionOf(JEVGUARD_PLUGIN_ENTRY)).toBeNull();
  });
});

describe("checkOpenCodeVersion", () => {
  test.each([
    ["2.2.2", "SUPPORTED"],
    ["opencode 2.2.9\n", "SUPPORTED"],
    ["2.2.1", "UNSUPPORTED"],
    ["2.3.0", "SUPPORTED"],
    ["2.3.9", "SUPPORTED"],
    ["2.4.0", "UNSUPPORTED"],
    ["2.1.1", "UNSUPPORTED"],
    ["3.2.2", "UNSUPPORTED"],
    ["2.3.1-beta.1", "UNSUPPORTED"],
  ] as const)("classifies %j as %s", (output, status) => {
    expect(checkOpenCodeVersion(output).status).toBe(status);
  });

  test("returns UNKNOWN without a readable version", () => {
    expect(checkOpenCodeVersion(null)).toEqual({ status: "UNKNOWN" });
    expect(checkOpenCodeVersion("opencode")).toEqual({ status: "UNKNOWN" });
  });

  test("names the range the package declares", () => {
    expect(OPENCODE_ENGINE_RANGE).toBe(">=2.2.2 <2.4");
  });

  test("names the newest supported line and how to pin it", () => {
    expect(OPENCODE_LATEST_SUPPORTED).toBe("2.3.x");
    expect(OPENCODE_PIN_COMMAND).toBe("npm install --global @opencode/cli@2.3");
  });
});

describe("resolveConfigPath", () => {
  test("resolves the global path under ~/.config without XDG_CONFIG_HOME", () => {
    expect(resolveConfigPath("global", { cwd: CWD, environment: {}, homedir: HOME })).toBe(
      GLOBAL_PATH,
    );
  });

  test("resolves the global path under XDG_CONFIG_HOME when set", () => {
    const environment = { XDG_CONFIG_HOME: XDG };

    expect(resolveConfigPath("global", { cwd: CWD, environment, homedir: HOME })).toBe(XDG_PATH);
  });

  test("falls back to ~/.config for an empty XDG_CONFIG_HOME", () => {
    const environment = { XDG_CONFIG_HOME: "" };

    expect(resolveConfigPath("global", { cwd: CWD, environment, homedir: HOME })).toBe(GLOBAL_PATH);
  });

  test("ignores a relative XDG_CONFIG_HOME and falls back to ~/.config", () => {
    const environment = { XDG_CONFIG_HOME: join("relative", "config") };

    expect(resolveConfigPath("global", { cwd: CWD, environment, homedir: HOME })).toBe(GLOBAL_PATH);
  });

  test("resolves the project path from the injected cwd", () => {
    expect(resolveConfigPath("project", { cwd: CWD, environment: {}, homedir: HOME })).toBe(
      PROJECT_PATH,
    );
  });
});

describe("install", () => {
  test("creates a missing global config with the documented default document", async () => {
    const { fileSystem, dependencies } = harness();

    const outcome = await install(dependencies);

    expect(outcome).toEqual({ status: "INSTALLED", target: "global", path: GLOBAL_PATH });
    expect(fileSystem.writes).toEqual([{ path: GLOBAL_PATH, contents: DEFAULT_DOCUMENT }]);
    expect(fileSystem.ensured).toEqual([GLOBAL_PATH]);
  });

  test("does not write or prompt when the pinned entry is already present", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugins: [JEVGUARD_PLUGIN_SPEC] })}\n`);

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "ALREADY_INSTALLED",
      target: "global",
      path: GLOBAL_PATH,
    });
    expect(fileSystem.writes).toEqual([]);
    expect(confirmation.messages).toEqual([]);
  });

  test("re-pins an unpinned entry after confirmation", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugins: [JEVGUARD_PLUGIN_ENTRY] })}\n`);

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "UPDATED",
      target: "global",
      path: GLOBAL_PATH,
      from: JEVGUARD_PLUGIN_ENTRY,
    });
    expect(confirmation.messages).toHaveLength(1);
    expect(confirmation.messages[0]).toContain("Update JevGuard");
    expect(confirmation.messages[0]).toContain(JEVGUARD_PLUGIN_SPEC);
    expect(JSON.parse(fileSystem.writes[0]?.contents ?? "")).toEqual({
      plugins: [JEVGUARD_PLUGIN_SPEC],
    });
  });

  test("re-pins a stale entry in the legacy key even when plugins is pinned", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    fileSystem.files.set(
      GLOBAL_PATH,
      `${JSON.stringify({
        plugins: [JEVGUARD_PLUGIN_SPEC],
        plugin: [`${JEVGUARD_PLUGIN_ENTRY}@0.3.0`],
      })}\n`,
    );

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "UPDATED",
      target: "global",
      path: GLOBAL_PATH,
      from: `${JEVGUARD_PLUGIN_ENTRY}@0.3.0`,
    });
    expect(confirmation.messages[0]).toContain("Update JevGuard");
    expect(JSON.parse(fileSystem.writes[0]?.contents ?? "")).toEqual({
      plugins: [JEVGUARD_PLUGIN_SPEC],
      plugin: [JEVGUARD_PLUGIN_SPEC],
    });
  });

  test("a second install after a re-pin changes nothing", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugin: [JEVGUARD_PLUGIN_ENTRY] })}\n`);

    await install(dependencies);
    const second = await install(dependencies);

    expect(second).toEqual({ status: "ALREADY_INSTALLED", target: "global", path: GLOBAL_PATH });
    expect(confirmation.messages).toHaveLength(1);
    expect(fileSystem.writes).toHaveLength(1);
  });

  test("writes nothing when the confirmation is declined", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    confirmation.result = { status: "DECLINED" };

    const outcome = await install(dependencies);

    expect(outcome).toEqual({ status: "ABORTED", target: "global", path: GLOBAL_PATH });
    expect(fileSystem.writes).toEqual([]);
  });

  test("refuses without a TTY and writes nothing", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    confirmation.result = { status: "FAILED", reason: "NOT_A_TTY" };

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "NOT_A_TTY",
    });
    expect(fileSystem.writes).toEqual([]);
  });

  test("maps a confirmation failure reason through to the outcome", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    confirmation.result = { status: "FAILED", reason: "NOT_A_TTY" };

    const outcome = await install(dependencies);

    expect(outcome).toMatchObject({ status: "FAILED", reason: "NOT_A_TTY" });
    expect(fileSystem.writes).toEqual([]);
  });

  test("prefers opencode.json over an existing sibling opencode.jsonc", async () => {
    const { fileSystem, dependencies } = harness();
    fileSystem.files.set(JSONC_PATH, "{ /* comment */ }\n");
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugins: [] })}\n`);

    const outcome = await install(dependencies);

    expect(outcome.status).toBe("INSTALLED");
    expect(fileSystem.writes[0]?.path).toBe(GLOBAL_PATH);
  });

  test("refuses when only an opencode.jsonc exists and writes nothing", async () => {
    const { fileSystem, dependencies } = harness();
    fileSystem.files.set(JSONC_PATH, "{ /* comment */ }\n");

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "UNSUPPORTED_JSONC",
    });
    expect(fileSystem.writes).toEqual([]);
  });

  test("refuses invalid JSON and writes nothing", async () => {
    const { fileSystem, dependencies } = harness();
    fileSystem.files.set(GLOBAL_PATH, "{ not json");

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "INVALID_JSON",
    });
    expect(fileSystem.writes).toEqual([]);
  });

  test("refuses an invalid plugin shape and writes nothing", async () => {
    const { fileSystem, dependencies } = harness();
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugins: "x" })}\n`);

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "INVALID_CONFIG_SHAPE",
    });
    expect(fileSystem.writes).toEqual([]);
  });

  test("surfaces a read failure without prompting or writing", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    fileSystem.readError = new Error("read failure");

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "READ_FAILURE",
    });
    expect(confirmation.messages).toEqual([]);
    expect(fileSystem.writes).toEqual([]);
  });

  test("surfaces a write failure after confirmation", async () => {
    const { fileSystem, dependencies } = harness();
    fileSystem.writeError = new Error("write failure");

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "WRITE_FAILURE",
    });
  });

  test("resolves the project path from the injected cwd", async () => {
    const { fileSystem, dependencies } = harness("project");

    const outcome = await install(dependencies);

    expect(outcome).toEqual({ status: "INSTALLED", target: "project", path: PROJECT_PATH });
    expect(fileSystem.writes[0]?.path).toBe(PROJECT_PATH);
  });
});

describe("node config file system", () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory !== null) {
      await rm(directory, { recursive: true, force: true });
      directory = null;
    }
  });

  test("creates the project config inside a temp directory", async () => {
    directory = await mkdtemp(join(tmpdir(), "jevguard-install-"));
    const path = join(directory, "opencode.json");

    const outcome = await install({
      target: "project",
      confirmation: { confirm: () => Promise.resolve({ status: "CONFIRMED" }) },
      fileSystem: createNodeConfigFileSystem(),
      cwd: directory,
      environment: {},
      homedir: HOME,
    });

    expect(outcome).toEqual({ status: "INSTALLED", target: "project", path });
    expect(await readFile(path, "utf8")).toBe(DEFAULT_DOCUMENT);
    expect(await readdir(directory)).toEqual(["opencode.json"]);
  });

  test("merges into an existing document and leaves no temporary file behind", async () => {
    directory = await mkdtemp(join(tmpdir(), "jevguard-install-merge-"));
    const path = join(directory, "opencode.json");
    await writeFile(path, `${JSON.stringify({ $schema: "schema" })}\n`, "utf8");

    const outcome = await install({
      target: "project",
      confirmation: { confirm: () => Promise.resolve({ status: "CONFIRMED" }) },
      fileSystem: createNodeConfigFileSystem(),
      cwd: directory,
      environment: {},
      homedir: HOME,
    });

    expect(outcome).toEqual({ status: "INSTALLED", target: "project", path });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      $schema: "schema",
      plugins: [JEVGUARD_PLUGIN_SPEC],
    });
    expect(await readdir(directory)).toEqual(["opencode.json"]);
  });

  test("leaves the target untouched and removes the temporary file when the replace fails", async () => {
    directory = await mkdtemp(join(tmpdir(), "jevguard-install-failure-"));
    const path = join(directory, "opencode.json");
    await mkdir(path);

    const fileSystem = createNodeConfigFileSystem();
    await fileSystem.ensureParentDirectory(path);

    await expect(fileSystem.writeFile(path, DEFAULT_DOCUMENT)).rejects.toThrow();
    expect(await readdir(directory)).toEqual(["opencode.json"]);
  });

  test("creates missing parent directories for the global target", async () => {
    directory = await mkdtemp(join(tmpdir(), "jevguard-install-home-"));
    const expectedPath = join(directory, ".config", "opencode", "opencode.json");

    const outcome = await install({
      target: "global",
      confirmation: { confirm: () => Promise.resolve({ status: "CONFIRMED" }) },
      fileSystem: createNodeConfigFileSystem(),
      cwd: directory,
      environment: {},
      homedir: directory,
    });

    expect(outcome.path).toBe(expectedPath);
    expect(await readFile(expectedPath, "utf8")).toBe(DEFAULT_DOCUMENT);
  });
});
