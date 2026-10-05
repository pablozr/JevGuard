import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createNodePolicyFileSystem, createPolicyFileLoader } from "../src/index";
import type { PolicyFileSystem } from "../src/index";

const ROOT = join("C:", "repo");

function enoent(): Error {
  return Object.assign(new Error("not found"), { code: "ENOENT" });
}

class FakeFileSystem implements PolicyFileSystem {
  readonly files = new Map<string, string>();
  readonly readPaths: string[] = [];
  failure: Error | null = null;
  failOn: string | null = null;

  async readFile(path: string): Promise<string> {
    this.readPaths.push(path);

    if (this.failure !== null && path === this.failOn) {
      throw this.failure;
    }

    const value = this.files.get(path);

    if (value === undefined) {
      throw enoent();
    }

    return value;
  }
}

const RULES_PATH = join(ROOT, ".jev", "rules.md");
const CONFIG_PATH = join(ROOT, ".jev", "config.yaml");

describe("policy file loader", () => {
  test("reads the two fixed paths under the root", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(RULES_PATH, "## ARCH-001");
    fileSystem.files.set(CONFIG_PATH, "version: 1");

    const loader = createPolicyFileLoader({ root: ROOT, fileSystem });
    const result = await loader.load();

    expect(result).toEqual({
      status: "LOADED",
      source: { rules: "## ARCH-001", config: "version: 1" },
    });
    expect(fileSystem.readPaths).toEqual([RULES_PATH, CONFIG_PATH]);
  });

  test("treats an absent rules file as null without treating it as failure", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(CONFIG_PATH, "version: 1");

    const result = await createPolicyFileLoader({ root: ROOT, fileSystem }).load();

    expect(result).toEqual({
      status: "LOADED",
      source: { rules: null, config: "version: 1" },
    });
  });

  test("treats an absent config file as null", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(RULES_PATH, "## ARCH-001");

    const result = await createPolicyFileLoader({ root: ROOT, fileSystem }).load();

    expect(result).toEqual({
      status: "LOADED",
      source: { rules: "## ARCH-001", config: null },
    });
  });

  test("fails the load on a non-ENOENT rules read failure without reading config", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.failOn = RULES_PATH;
    fileSystem.failure = Object.assign(new Error("access denied"), { code: "EACCES" });

    const result = await createPolicyFileLoader({ root: ROOT, fileSystem }).load();

    expect(result).toEqual({ status: "FAILED", reason: "RULES_READ_FAILURE" });
    expect(fileSystem.readPaths).toEqual([RULES_PATH]);
  });

  test("fails the load on a non-ENOENT config read failure", async () => {
    const fileSystem = new FakeFileSystem();
    fileSystem.files.set(RULES_PATH, "## ARCH-001");
    fileSystem.failOn = CONFIG_PATH;
    fileSystem.failure = Object.assign(new Error("device error"), { code: "EIO" });

    const result = await createPolicyFileLoader({ root: ROOT, fileSystem }).load();

    expect(result).toEqual({ status: "FAILED", reason: "CONFIG_READ_FAILURE" });
  });
});

describe("node policy file system", () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory !== null) {
      await rm(directory, { recursive: true, force: true });
      directory = null;
    }
  });

  test("reads policy files as UTF-8 and reports absence as ENOENT", async () => {
    directory = await mkdtemp(join(tmpdir(), "jevguard-policy-"));
    await mkdir(join(directory, ".jev"), { recursive: true });
    await writeFile(join(directory, ".jev", "rules.md"), "## ARCH-001\n\nCafé policy\n", "utf8");

    const loader = createPolicyFileLoader({
      root: directory,
      fileSystem: createNodePolicyFileSystem(),
    });
    const result = await loader.load();

    expect(result).toEqual({
      status: "LOADED",
      source: { rules: "## ARCH-001\n\nCafé policy\n", config: null },
    });
  });
});
