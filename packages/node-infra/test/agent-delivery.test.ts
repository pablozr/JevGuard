import { describe, expect, test } from "vitest";
import {
  enableAgentDelivery,
  inspectAgentDelivery,
  loadRemediationUserSettings,
  type ProjectProbe,
  parsePolicyConfig,
  type TextFileSystem,
  type UserConfigEnvironment,
  userConfigFileOf,
} from "../src";

const ENVIRONMENT: UserConfigEnvironment = {
  xdgConfigHome: "/home/u/.config",
  userProfile: undefined,
  home: "/home/u",
};
const FILE = "/home/u/.config/jevguard/opencode.yaml";
const RULES = { isModel: (value: string) => value.includes("/") };

function createFiles(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: string[] = [];
  const directories: string[] = [];
  const files: TextFileSystem = {
    readText: async (path) => store.get(path) ?? null,
    exists: async (path) => store.has(path),
    writeTextAtomic: async (path, text) => {
      writes.push(path);
      store.set(path, text);
    },
    makeDirectory: async (path) => {
      directories.push(path);
    },
  };

  return { files, store, writes, directories };
}

const probe: ProjectProbe = {
  realPath: (path) => path,
  hasGitMarker: (directory) => directory === "/work/repo",
};

function input(files: TextFileSystem, environment = ENVIRONMENT) {
  return {
    environment,
    fileName: "opencode.yaml",
    rules: RULES,
    projectRoot: "/work/repo",
    probe,
    files,
  };
}

function reload(text: string) {
  return loadRemediationUserSettings(
    {
      file: FILE,
      projectRoot: "/work/repo",
      ...probe,
      readText: () => text,
      parse: (value) => {
        const parsed = parsePolicyConfig(value);

        return parsed.status === "PARSED"
          ? { status: "PARSED", value: parsed.value }
          : { status: "INVALID" };
      },
    },
    RULES,
  );
}

describe("enableAgentDelivery", () => {
  test("creates the file with agent delivery and the directory first", async () => {
    const fake = createFiles();

    const result = await enableAgentDelivery(input(fake.files));

    expect(result).toEqual({ status: "ENABLED", path: FILE });
    expect(fake.directories).toEqual(["/home/u/.config/jevguard"]);
    expect(reload(fake.store.get(FILE) ?? "")).toEqual({
      status: "ENABLED",
      settings: { delivery: "agent", model: null },
      warnings: [],
    });
  });

  test("is idempotent: the second call reports ALREADY_ENABLED and writes nothing", async () => {
    const fake = createFiles();

    await enableAgentDelivery(input(fake.files));
    const second = await enableAgentDelivery(input(fake.files));

    expect(second).toEqual({ status: "ALREADY_ENABLED", path: FILE });
    expect(fake.writes).toHaveLength(1);
  });

  test("keeps a valid model and upgrades user delivery", async () => {
    const fake = createFiles({
      [FILE]: "remediation:\n  enabled: true\n  model: openai/gpt-5\n",
    });

    const result = await enableAgentDelivery(input(fake.files));

    expect(result.status).toBe("ENABLED");
    expect(reload(fake.store.get(FILE) ?? "")).toEqual({
      status: "ENABLED",
      settings: { delivery: "agent", model: "openai/gpt-5" },
      warnings: [],
    });
  });

  test("enables a section that was explicitly disabled", async () => {
    const fake = createFiles({ [FILE]: "remediation:\n  enabled: false\n" });

    expect((await enableAgentDelivery(input(fake.files))).status).toBe("ENABLED");
  });

  test("treats an empty file as absent", async () => {
    const fake = createFiles({ [FILE]: "  \n" });

    expect((await enableAgentDelivery(input(fake.files))).status).toBe("ENABLED");
  });

  test.each([
    ["an unknown key", "remediation:\n  enabled: true\n  chain: true\n"],
    ["a foreign root key", "other: 1\n"],
    ["broken yaml", "remediation: [\n"],
  ])("leaves a file with %s untouched", async (_name, text) => {
    const fake = createFiles({ [FILE]: text });

    const result = await enableAgentDelivery(input(fake.files));

    expect(result).toEqual({ status: "INVALID_EXISTING", path: FILE });
    expect(fake.writes).toEqual([]);
    expect(fake.store.get(FILE)).toBe(text);
  });

  test("refuses a file inside the project without writing", async () => {
    const fake = createFiles();
    const environment = { ...ENVIRONMENT, xdgConfigHome: "/work/repo/.config" };

    const result = await enableAgentDelivery(input(fake.files, environment));

    expect(result).toEqual({
      status: "INSIDE_PROJECT",
      path: userConfigFileOf(environment, "opencode.yaml"),
    });
    expect(fake.writes).toEqual([]);
    expect(fake.directories).toEqual([]);
  });

  test("reports a missing config home", async () => {
    const fake = createFiles();
    const environment: UserConfigEnvironment = {
      xdgConfigHome: undefined,
      userProfile: undefined,
      home: undefined,
    };

    expect(await enableAgentDelivery(input(fake.files, environment))).toEqual({
      status: "NO_CONFIG_HOME",
      path: null,
    });
  });

  test("maps a failing write to WRITE_FAILED", async () => {
    const fake = createFiles();
    const files: TextFileSystem = {
      ...fake.files,
      writeTextAtomic: async () => {
        throw new Error("disk full");
      },
    };

    expect(await enableAgentDelivery(input(files))).toEqual({ status: "WRITE_FAILED", path: FILE });
  });
});

describe("inspectAgentDelivery", () => {
  test("reports WOULD_ENABLE without writing", async () => {
    const fake = createFiles();

    expect(await inspectAgentDelivery(input(fake.files))).toEqual({
      status: "WOULD_ENABLE",
      path: FILE,
    });
    expect(fake.writes).toEqual([]);
  });

  test("reports ALREADY_ENABLED", async () => {
    const fake = createFiles({ [FILE]: "remediation:\n  enabled: true\n  delivery: agent\n" });

    expect((await inspectAgentDelivery(input(fake.files))).status).toBe("ALREADY_ENABLED");
  });
});
