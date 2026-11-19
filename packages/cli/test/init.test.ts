import { dirname } from "node:path";
import {
  type HostCliContext,
  type HostCliExtension,
  type HostDetection,
  type HostInstallOutcome,
  type HostInstallScope,
  policyFilePaths,
  type TextFileSystem,
} from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import { parseInitArguments } from "../src/init/arguments";
import { runInit } from "../src/init/run-init";
import { STARTER_RULES } from "../src/setup/scaffold";

const PROJECT_ROOT = "C:/repo";
const RULES_PATH = policyFilePaths(PROJECT_ROOT).rules;

class MemoryFiles implements TextFileSystem {
  readonly store = new Map<string, string>();

  async readText(path: string): Promise<string | null> {
    return this.store.get(path) ?? null;
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(path);
  }

  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.store.set(path, text);
  }

  async makeDirectory(path: string): Promise<void> {
    const parent = dirname(path);

    if (parent !== path) this.store.set(`${parent}/`, "");
  }
}

function contextOf(files: TextFileSystem): HostCliContext {
  return {
    cwd: PROJECT_ROOT,
    projectRoot: PROJECT_ROOT,
    homedir: "C:/home",
    environment: { xdgConfigHome: undefined, userProfile: undefined, home: undefined },
    variable: () => undefined,
    processes: { run: async () => ({ kind: "FAILED" }) },
    files,
    confirmation: { confirm: async () => ({ status: "DECLINED" }) },
  };
}

interface HostOptions {
  readonly id?: "opencode" | "claude-code";
  readonly detection?: HostDetection["status"];
  readonly install?: HostInstallOutcome["status"];
}

function host(options: HostOptions = {}): {
  extension: HostCliExtension;
  calls: { scope: HostInstallScope; confirmed: boolean }[];
} {
  const calls: { scope: HostInstallScope; confirmed: boolean }[] = [];
  const id = options.id ?? "opencode";
  const detection = options.detection ?? "SUPPORTED";
  const detectionValue: HostDetection = {
    host: id,
    status: detection,
    version: detection === "NOT_FOUND" ? null : "2.3.0",
    supportedRange: ">=2.2.2 <2.3",
  };

  return {
    calls,
    extension: {
      id,
      displayName: "OpenCode",
      userConfigFileName: "opencode.json",
      remediationRules: { isModel: () => true },
      detect: async () => detectionValue,
      inspectInstall: async () => ({ state: "NOT_INSTALLED", target: "target" }),
      install: async (context, scope) => {
        const answer = await context.confirmation.confirm("register?");

        calls.push({ scope, confirmed: answer.status === "CONFIRMED" });

        const status = options.install ?? "CHANGED";

        return status === "CHANGED"
          ? {
              status,
              code: "INSTALLED",
              lines: [`Registered JevGuard in ${PROJECT_ROOT}/opencode.json.`],
            }
          : { status, code: "ALREADY_INSTALLED", lines: ["JevGuard is already registered."] };
      },
      doctor: async () => [],
    },
  };
}

describe("parseInitArguments", () => {
  test("defaults to the default host and the project scope", () => {
    expect(parseInitArguments([])).toEqual({ host: "opencode", scope: "project" });
  });

  test("reads --host and --global", () => {
    expect(parseInitArguments(["--host", "claude-code", "--global"])).toEqual({
      host: "claude-code",
      scope: "global",
    });
  });

  test.each([["--host"], ["--json"], ["--global", "--global"], ["--host", "nope"]])(
    "refuses %j",
    (...args) => {
      expect(parseInitArguments(args)).toBeNull();
    },
  );
});

describe("runInit", () => {
  test("registers the plugin in the project and creates the example rules", async () => {
    const files = new MemoryFiles();
    const opencode = host();

    const result = await runInit(
      { context: contextOf(files), extensions: [opencode.extension] },
      { host: "opencode", scope: "project" },
    );

    expect(result.status).toBe("CREATED");
    expect(result.rules).toBe("CREATED");
    expect(opencode.calls).toEqual([{ scope: "project", confirmed: true }]);
    expect(files.store.get(RULES_PATH)).toBe(STARTER_RULES);
    expect(result.lines.join("\n")).toContain(`Created ${RULES_PATH}`);
  });

  test("never replaces an existing rules file", async () => {
    const files = new MemoryFiles();
    files.store.set(RULES_PATH, "my own rules");
    const opencode = host();

    const result = await runInit(
      { context: contextOf(files), extensions: [opencode.extension] },
      { host: "opencode", scope: "project" },
    );

    expect(result.rules).toBe("EXISTS");
    expect(files.store.get(RULES_PATH)).toBe("my own rules");
    expect(result.lines.join("\n")).toContain("already exists; left unchanged");
  });

  test("reports ALREADY when the plugin was registered and the rules existed", async () => {
    const files = new MemoryFiles();
    files.store.set(RULES_PATH, "my own rules");
    const opencode = host({ install: "UNCHANGED" });

    const result = await runInit(
      { context: contextOf(files), extensions: [opencode.extension] },
      { host: "opencode", scope: "project" },
    );

    expect(result.status).toBe("ALREADY");
  });

  test("writes no rules and names the pin when no host is supported", async () => {
    const files = new MemoryFiles();
    const opencode = host({ detection: "UNSUPPORTED" });

    const result = await runInit(
      { context: contextOf(files), extensions: [opencode.extension] },
      { host: "opencode", scope: "project" },
    );

    expect(result.status).toBe("NO_HOST");
    expect(result.rules).toBeNull();
    expect(opencode.calls).toEqual([]);
    expect(files.store.has(RULES_PATH)).toBe(false);
    expect(result.lines.join("\n")).toContain("No supported host was found");
  });

  test("a failed registration writes no rules and exits as FAILED", async () => {
    const files = new MemoryFiles();
    const opencode = host({ install: "FAILED" });

    const result = await runInit(
      { context: contextOf(files), extensions: [opencode.extension] },
      { host: "opencode", scope: "project" },
    );

    expect(result.status).toBe("FAILED");
    expect(result.rules).toBeNull();
    expect(files.store.has(RULES_PATH)).toBe(false);
  });

  test("only the asked host is touched", async () => {
    const files = new MemoryFiles();
    const opencode = host();
    const claude = host({ id: "claude-code" });

    await runInit(
      { context: contextOf(files), extensions: [opencode.extension, claude.extension] },
      { host: "opencode", scope: "project" },
    );

    expect(claude.calls).toEqual([]);
  });
});
