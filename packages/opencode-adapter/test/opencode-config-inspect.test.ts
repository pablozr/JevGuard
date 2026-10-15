import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { inspectInstall, JEVGUARD_PLUGIN_ENTRY } from "../src/index";
import type { InspectInstallDependencies, InstallTarget } from "../src/index";

const CWD = join("C:", "repo");
const HOME = join("C:", "home");
const XDG = join("D:", "xdg");

const GLOBAL_PATH = join(HOME, ".config", "opencode", "opencode.json");
const XDG_PATH = join(XDG, "opencode", "opencode.json");
const PROJECT_PATH = join(CWD, "opencode.json");
const JSONC_PATH = join(dirname(GLOBAL_PATH), "opencode.jsonc");

class FakeFileSystem {
  readonly files = new Map<string, string>();
  readonly reads: string[] = [];
  readError: Error | null = null;
  existsError: Error | null = null;

  readFile(path: string): Promise<string | null> {
    this.reads.push(path);

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
}

function inspect(
  fileSystem: FakeFileSystem,
  target: InstallTarget,
  environment: Readonly<Record<string, string | undefined>> = {},
) {
  const dependencies: InspectInstallDependencies = {
    target,
    fileSystem,
    cwd: CWD,
    environment,
    homedir: HOME,
  };

  return inspectInstall(dependencies);
}

function pluginDocument(...plugins: readonly string[]): string {
  return JSON.stringify({ plugin: plugins });
}

describe("inspectInstall", () => {
  test("reports REGISTERED for the exact entry", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(GLOBAL_PATH, pluginDocument("other", JEVGUARD_PLUGIN_ENTRY));

    const result = await inspect(fileSystem, "global");

    expect(result).toEqual({ status: "REGISTERED", target: "global", path: GLOBAL_PATH });
  });

  test("reports REGISTERED for a pinned version entry", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(PROJECT_PATH, pluginDocument(`${JEVGUARD_PLUGIN_ENTRY}@0.2.3`));

    const result = await inspect(fileSystem, "project");

    expect(result).toEqual({ status: "REGISTERED", target: "project", path: PROJECT_PATH });
  });

  test("reports NOT_REGISTERED when the file is absent", async () => {
    const result = await inspect(new FakeFileSystem(), "global");

    expect(result).toEqual({ status: "NOT_REGISTERED", target: "global", path: GLOBAL_PATH });
  });

  test("reports NOT_REGISTERED when the file has no JevGuard entry", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(GLOBAL_PATH, pluginDocument("other"));

    const result = await inspect(fileSystem, "global");

    expect(result.status).toBe("NOT_REGISTERED");
  });

  test("reports UNSUPPORTED_JSONC when only a sibling opencode.jsonc exists", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(JSONC_PATH, "{}");

    const result = await inspect(fileSystem, "global");

    expect(result).toEqual({
      status: "FAILED",
      target: "global",
      path: GLOBAL_PATH,
      reason: "UNSUPPORTED_JSONC",
    });
  });

  test("reports INVALID_JSON for unparseable content", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(GLOBAL_PATH, "{ not json");

    const result = await inspect(fileSystem, "global");

    expect(result).toMatchObject({ status: "FAILED", reason: "INVALID_JSON" });
  });

  test.each([
    ["a non-object document", "[]"],
    ["a non-array plugin value", JSON.stringify({ plugin: "x" })],
    ["a non-string plugin item", JSON.stringify({ plugin: [1] })],
  ])("reports INVALID_CONFIG_SHAPE for %s", async (_name, contents) => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(GLOBAL_PATH, contents);

    const result = await inspect(fileSystem, "global");

    expect(result).toMatchObject({ status: "FAILED", reason: "INVALID_CONFIG_SHAPE" });
  });

  test("reports READ_FAILURE when reading throws", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.readError = new Error("EACCES");

    const result = await inspect(fileSystem, "global");

    expect(result).toMatchObject({ status: "FAILED", reason: "READ_FAILURE" });
  });

  test("reports READ_FAILURE when the sibling check throws", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.existsError = new Error("EIO");

    const result = await inspect(fileSystem, "global");

    expect(result).toMatchObject({ status: "FAILED", reason: "READ_FAILURE" });
  });

  test("resolves the global path from an absolute XDG_CONFIG_HOME", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(XDG_PATH, pluginDocument(JEVGUARD_PLUGIN_ENTRY));

    const result = await inspect(fileSystem, "global", { XDG_CONFIG_HOME: XDG });

    expect(result).toEqual({ status: "REGISTERED", target: "global", path: XDG_PATH });
  });

  test("resolves the project path under the working directory and only reads it", async () => {
    const fileSystem = new FakeFileSystem();

    const result = await inspect(fileSystem, "project");

    expect(result.path).toBe(PROJECT_PATH);
    expect(fileSystem.reads).toEqual([PROJECT_PATH]);
  });
});
