import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  addPluginEntry,
  createConfirmationPrompt,
  createNodeConfigFileSystem,
  install,
  JEVGUARD_PLUGIN_ENTRY,
  resolveConfigPath,
} from "../src/index";
import type {
  ConfigFileSystem,
  ConfirmationPrompt,
  ConfirmationResult,
  InstallDependencies,
  InstallTarget,
} from "../src/index";

const CWD = join("C:", "repo");
const HOME = join("C:", "home");
const XDG = join("D:", "xdg");

const GLOBAL_PATH = join(HOME, ".config", "opencode", "opencode.json");
const XDG_PATH = join(XDG, "opencode", "opencode.json");
const PROJECT_PATH = join(CWD, "opencode.json");
const JSONC_PATH = join(dirname(GLOBAL_PATH), "opencode.jsonc");
const DEFAULT_DOCUMENT = `${JSON.stringify(
  { $schema: "https://opencode.ai/config.json", plugin: [JEVGUARD_PLUGIN_ENTRY] },
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
  test("adds the entry when the plugin key is absent", () => {
    const result = addPluginEntry({ $schema: "schema" }, JEVGUARD_PLUGIN_ENTRY);

    expect(result).toEqual({
      status: "ADDED",
      document: { $schema: "schema", plugin: [JEVGUARD_PLUGIN_ENTRY] },
    });
  });

  test("detects the exact entry and a version-suffixed entry as present", () => {
    expect(addPluginEntry({ plugin: [JEVGUARD_PLUGIN_ENTRY] }, JEVGUARD_PLUGIN_ENTRY)).toEqual({
      status: "PRESENT",
    });
    expect(
      addPluginEntry({ plugin: [`${JEVGUARD_PLUGIN_ENTRY}@1.2.3`] }, JEVGUARD_PLUGIN_ENTRY),
    ).toEqual({ status: "PRESENT" });
  });

  test("preserves unknown keys, their order, and existing plugin entries", () => {
    const result = addPluginEntry(
      { $schema: "schema", model: "gpt", plugin: ["other-plugin"] },
      JEVGUARD_PLUGIN_ENTRY,
    );

    expect(result.status).toBe("ADDED");

    if (result.status !== "ADDED") {
      throw new Error("expected ADDED");
    }

    expect(Object.keys(result.document)).toEqual(["$schema", "model", "plugin"]);
    expect(result.document.plugin).toEqual(["other-plugin", JEVGUARD_PLUGIN_ENTRY]);
  });

  test("refuses a non-object document", () => {
    expect(addPluginEntry(["plugin"], JEVGUARD_PLUGIN_ENTRY)).toEqual({ status: "INVALID_SHAPE" });
    expect(addPluginEntry(null, JEVGUARD_PLUGIN_ENTRY)).toEqual({ status: "INVALID_SHAPE" });
  });

  test("refuses a plugin value that is not an array of strings", () => {
    expect(addPluginEntry({ plugin: "x" }, JEVGUARD_PLUGIN_ENTRY)).toEqual({
      status: "INVALID_SHAPE",
    });
    expect(addPluginEntry({ plugin: [42] }, JEVGUARD_PLUGIN_ENTRY)).toEqual({
      status: "INVALID_SHAPE",
    });
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

  test("does not write or prompt when the entry is already present", async () => {
    const { fileSystem, confirmation, dependencies } = harness();
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugin: [JEVGUARD_PLUGIN_ENTRY] })}\n`);

    const outcome = await install(dependencies);

    expect(outcome).toEqual({
      status: "ALREADY_INSTALLED",
      target: "global",
      path: GLOBAL_PATH,
    });
    expect(fileSystem.writes).toEqual([]);
    expect(confirmation.messages).toEqual([]);
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
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugin: [] })}\n`);

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
    fileSystem.files.set(GLOBAL_PATH, `${JSON.stringify({ plugin: "x" })}\n`);

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
      plugin: [JEVGUARD_PLUGIN_ENTRY],
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

describe("node confirmation prompt", () => {
  test("refuses off a TTY", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    try {
      const result = await createConfirmationPrompt().confirm("Proceed?");

      expect(result).toEqual({ status: "FAILED", reason: "NOT_A_TTY" });
    } finally {
      if (original !== undefined) {
        Object.defineProperty(process.stdin, "isTTY", original);
      }
    }
  });
});
