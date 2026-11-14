import { type CredentialProvider, parseRules } from "@jevguard/core";
import type {
  ConfirmationResult,
  HostCliContext,
  HostCliExtension,
  HostDetection,
  HostId,
  HostInstallOutcome,
  HostInstallState,
  LoginOutcome,
  ProjectProbe,
  TextFileSystem,
} from "@jevguard/node-infra";
import { policyFilePaths } from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import { normalize } from "node:path";
import { parseSetupArguments } from "../src/setup/arguments";
import { runSetup } from "../src/setup/run-setup";
import { STARTER_RULES } from "../src/setup/scaffold";
import type { SetupPorts, SetupRequest } from "../src/setup/types";

const PROJECT_ROOT = "/work/project";
const CONFIG_HOME = "/home/user/.config";
const OPENCODE_CONFIG = `${CONFIG_HOME}/jevguard/opencode.yaml`;
const CLAUDE_CONFIG = `${CONFIG_HOME}/jevguard/claude-code.yaml`;

const REQUEST: SetupRequest = {
  host: null,
  scope: "global",
  init: false,
  agentDelivery: false,
  yes: false,
};

function memoryFiles(initial: Record<string, string> = {}): {
  files: TextFileSystem;
  store: Map<string, string>;
  writes: string[];
} {
  const store = new Map(Object.entries(initial));
  const writes: string[] = [];
  const files: TextFileSystem = {
    readText: async (path) => store.get(path) ?? null,
    exists: async (path) => store.has(path),
    writeTextAtomic: async (path, text) => {
      writes.push(path);
      store.set(path, text);
    },
    makeDirectory: async () => undefined,
  };

  return { files, store, writes };
}

const PROBE: ProjectProbe = {
  realPath: (path) => path,
  hasGitMarker: () => false,
};

interface FakeHostOptions {
  readonly id: HostId;
  readonly detection?: HostDetection["status"];
  readonly state?: HostInstallState;
  readonly install?: HostInstallOutcome;
  readonly fileName: string;
}

function fakeHost(options: FakeHostOptions): { extension: HostCliExtension; installs: number[] } {
  const installs: number[] = [];
  const detection = options.detection ?? "SUPPORTED";
  const outcome: HostInstallOutcome = options.install ?? {
    status: "CHANGED",
    code: "INSTALLED",
    lines: [`installed ${options.id}`],
  };
  const extension: HostCliExtension = {
    id: options.id,
    displayName: options.id === "opencode" ? "OpenCode" : "Claude Code",
    userConfigFileName: options.fileName,
    remediationRules: { isModel: () => true },
    detect: async () => ({
      host: options.id,
      status: detection,
      version: detection === "NOT_FOUND" ? null : "9.9.9",
      supportedRange: ">=1.0.0",
    }),
    inspectInstall: async () => ({ state: options.state ?? "NOT_INSTALLED", target: "target" }),
    install: async () => {
      installs.push(installs.length + 1);

      return outcome;
    },
    doctor: async () => [],
  };

  return { extension, installs };
}

function contextOf(
  files: TextFileSystem,
  answer: ConfirmationResult,
): { context: HostCliContext; questions: string[] } {
  const questions: string[] = [];
  const context: HostCliContext = {
    cwd: PROJECT_ROOT,
    projectRoot: PROJECT_ROOT,
    homedir: "/home/user",
    environment: { xdgConfigHome: CONFIG_HOME, userProfile: undefined, home: undefined },
    variable: () => undefined,
    processes: { run: async () => ({ kind: "FAILED" }) },
    files,
    confirmation: {
      confirm: async (message) => {
        questions.push(message);

        return answer;
      },
    },
  };

  return { context, questions };
}

const NO_TTY: ConfirmationResult = { status: "FAILED", reason: "NOT_A_TTY" };

describe("parseSetupArguments", () => {
  test("defaults to every host, global scope and no optional step", () => {
    expect(parseSetupArguments([])).toEqual(REQUEST);
  });

  test("accepts every flag and a host", () => {
    expect(
      parseSetupArguments([
        "--host",
        "opencode",
        "--project",
        "--init",
        "--yes",
        "--agent-delivery",
      ]),
    ).toEqual({ host: "opencode", scope: "project", init: true, agentDelivery: true, yes: true });
  });

  test.each([
    [["--host"]],
    [["--host", "vim"]],
    [["--host", "opencode", "--host", "claude-code"]],
    [["--yes", "--yes"]],
    [["--force"]],
    [["extra"]],
  ])("rejects %j", (args) => {
    expect(parseSetupArguments(args)).toBeNull();
  });
});

describe("starter rules", () => {
  test("parse as one valid rule", () => {
    const results = parseRules(STARTER_RULES);

    expect(results).toHaveLength(1);
    expect(results.every((result) => result.status !== "INVALID")).toBe(true);
  });
});

const SENTINEL_KEY = "sk-sentinel-secret-key";
const ENABLED_DELIVERY = "remediation:\n  enabled: true\n  delivery: agent\n";

interface Scenario {
  readonly files?: Record<string, string>;
  readonly hosts?: readonly HostCliExtension[];
  readonly answer?: ConfirmationResult;
  readonly credential?: "STORE" | "ENVIRONMENT" | null;
  readonly loginOutcome?: LoginOutcome;
}

function scenario(options: Scenario = {}): {
  ports: SetupPorts;
  memory: ReturnType<typeof memoryFiles>;
  questions: string[];
  logins: number[];
} {
  const memory = memoryFiles(options.files);
  const { context, questions } = contextOf(memory.files, options.answer ?? NO_TTY);
  const logins: number[] = [];
  const credential = options.credential === undefined ? "STORE" : options.credential;
  const credentials: CredentialProvider = {
    resolve: async () =>
      credential === null
        ? { status: "UNAVAILABLE", reason: "MISSING_CREDENTIAL" }
        : { status: "AVAILABLE", source: credential, apiKey: SENTINEL_KEY },
  };
  const ports: SetupPorts = {
    context,
    extensions: options.hosts ?? [
      fakeHost({ id: "opencode", fileName: "opencode.yaml" }).extension,
    ],
    probe: PROBE,
    credentials,
    login: async () => {
      logins.push(logins.length + 1);

      return options.loginOutcome ?? { status: "SAVED" };
    },
  };

  return { ports, memory, questions, logins };
}

describe("runSetup", () => {
  test("without a terminal and without --yes it prints the plan and writes nothing", async () => {
    const host = fakeHost({ id: "opencode", fileName: "opencode.yaml" });
    const { ports, memory, logins } = scenario({ hosts: [host.extension], credential: null });

    const result = await runSetup(ports, REQUEST);

    expect(result.status).toBe("NOT_CONFIRMED");
    expect(result.lines.join("\n")).toContain("[todo] OpenCode: install JevGuard (global).");
    expect(host.installs).toEqual([]);
    expect(logins).toEqual([]);
    expect(memory.writes).toEqual([]);
  });

  test("--yes installs but creates neither .jev/rules.md nor the delivery config", async () => {
    const host = fakeHost({ id: "opencode", fileName: "opencode.yaml" });
    const { ports, memory } = scenario({ hosts: [host.extension] });

    const result = await runSetup(ports, { ...REQUEST, yes: true });

    expect(result.status).toBe("APPLIED");
    expect(host.installs).toHaveLength(1);
    expect(memory.store.has(policyFilePaths(PROJECT_ROOT).rules)).toBe(false);
    expect(memory.store.has(OPENCODE_CONFIG)).toBe(false);
    expect(result.lines.join("\n")).toContain("Skipped: create a starter");
  });

  test("--yes --init creates the starter rules and never overwrites existing ones", async () => {
    const host = fakeHost({ id: "opencode", fileName: "opencode.yaml" });
    const { ports, memory } = scenario({ hosts: [host.extension] });

    const first = await runSetup(ports, { ...REQUEST, yes: true, init: true });

    expect(first.status).toBe("APPLIED");
    expect(memory.store.get(policyFilePaths(PROJECT_ROOT).rules)).toBe(STARTER_RULES);

    memory.store.set(policyFilePaths(PROJECT_ROOT).rules, "custom rules");
    memory.store.set(OPENCODE_CONFIG, ENABLED_DELIVERY);

    const installed = fakeHost({ id: "opencode", fileName: "opencode.yaml", state: "INSTALLED" });
    const second = await runSetup(
      { ...ports, extensions: [installed.extension] },
      { ...REQUEST, yes: true, init: true },
    );

    expect(second.status).toBe("NOTHING_TO_DO");
    expect(memory.store.get(policyFilePaths(PROJECT_ROOT).rules)).toBe("custom rules");
  });

  test("an interactive yes applies every step and an interactive no skips them", async () => {
    const accepted = scenario({ answer: { status: "CONFIRMED" } });

    const applied = await runSetup(accepted.ports, REQUEST);

    expect(applied.status).toBe("APPLIED");
    expect(accepted.questions).toHaveLength(3);
    expect(accepted.memory.store.has(policyFilePaths(PROJECT_ROOT).rules)).toBe(true);
    expect(accepted.memory.store.get(OPENCODE_CONFIG)).toContain("delivery: agent");

    const host = fakeHost({ id: "opencode", fileName: "opencode.yaml" });
    const declined = scenario({ hosts: [host.extension], answer: { status: "DECLINED" } });

    const skipped = await runSetup(declined.ports, REQUEST);

    expect(skipped.status).toBe("APPLIED");
    expect(host.installs).toEqual([]);
    expect(declined.memory.writes).toEqual([]);
  });

  test("reports NO_HOST when no host is supported", async () => {
    const host = fakeHost({ id: "opencode", fileName: "opencode.yaml", detection: "NOT_FOUND" });
    const { ports, memory } = scenario({ hosts: [host.extension] });

    const result = await runSetup(ports, { ...REQUEST, yes: true, init: true });

    expect(result.status).toBe("NO_HOST");
    expect(host.installs).toEqual([]);
    expect(memory.writes).toEqual([]);
  });

  test("reports NOTHING_TO_DO when everything is already in place", async () => {
    const host = fakeHost({ id: "opencode", fileName: "opencode.yaml", state: "INSTALLED" });
    const { ports, logins } = scenario({
      hosts: [host.extension],
      files: {
        [policyFilePaths(PROJECT_ROOT).rules]: STARTER_RULES,
        [OPENCODE_CONFIG]: ENABLED_DELIVERY,
      },
    });

    const result = await runSetup(ports, REQUEST);

    expect(result.status).toBe("NOTHING_TO_DO");
    expect(host.installs).toEqual([]);
    expect(logins).toEqual([]);
    expect(result.lines.join("\n")).not.toContain("jevguard login");
  });

  test("reports FAILED when the host install fails", async () => {
    const host = fakeHost({
      id: "claude-code",
      fileName: "claude-code.yaml",
      install: { status: "FAILED", code: "INSTALL_FAILED", lines: ["install failed"] },
    });
    const { ports } = scenario({ hosts: [host.extension] });

    const result = await runSetup(ports, { ...REQUEST, yes: true });

    expect(result.status).toBe("FAILED");
    expect(result.lines).toContain("install failed");
  });

  test("--host limits the plan to one extension", async () => {
    const opencode = fakeHost({ id: "opencode", fileName: "opencode.yaml" });
    const claude = fakeHost({ id: "claude-code", fileName: "claude-code.yaml" });
    const { ports } = scenario({ hosts: [opencode.extension, claude.extension] });

    await runSetup(ports, { ...REQUEST, host: "claude-code", yes: true });

    expect(opencode.installs).toEqual([]);
    expect(claude.installs).toHaveLength(1);
  });
});

describe("runSetup credential step", () => {
  test("a stored credential is done and login is not called", async () => {
    const { ports, logins } = scenario();

    const result = await runSetup(ports, { ...REQUEST, yes: true });

    expect(logins).toEqual([]);
    expect(result.lines).toContain("[done] Jev API key found in the OS credential store.");
    expect(result.lines.join("\n")).not.toContain("jevguard login");
  });

  test("the environment override is reported without its value", async () => {
    const { ports } = scenario({ credential: "ENVIRONMENT" });

    const result = await runSetup(ports, { ...REQUEST, yes: true });

    expect(result.lines.join("\n")).toContain("TYPESAFE_API_KEY override");
    expect(result.lines.join("\n")).not.toContain(SENTINEL_KEY);
  });

  test("a missing credential is the first step and an interactive yes runs login", async () => {
    const { ports, logins, questions } = scenario({
      credential: null,
      answer: { status: "CONFIRMED" },
    });

    const result = await runSetup(ports, REQUEST);

    expect(result.lines[1]).toContain("[todo] store your Jev API key");
    expect(questions[0]).toContain("Jev API key");
    expect(logins).toHaveLength(1);
    expect(result.status).toBe("APPLIED");
    expect(result.lines.join("\n")).not.toContain("run `jevguard login`");
  });

  test("--yes logs in without asking first", async () => {
    const { ports, logins, questions } = scenario({ credential: null });

    const result = await runSetup(ports, { ...REQUEST, yes: true });

    expect(questions).toEqual([]);
    expect(logins).toHaveLength(1);
    expect(result.status).toBe("APPLIED");
    expect(result.lines.at(-1)).toBe("Next: run `jevguard doctor` to check the setup.");
  });

  test("without a terminal the other steps still run and setup fails with a login hint", async () => {
    const host = fakeHost({ id: "opencode", fileName: "opencode.yaml" });
    const { ports } = scenario({
      hosts: [host.extension],
      credential: null,
      loginOutcome: { status: "FAILED", reason: "NOT_A_TTY" },
    });

    const result = await runSetup(ports, { ...REQUEST, yes: true, init: true });

    expect(result.status).toBe("FAILED");
    expect(host.installs).toHaveLength(1);
    expect(result.lines).toContain("Run `jevguard login` in a terminal to store your API key.");
    expect(result.lines.at(-1)).toContain("run `jevguard login`");
  });

  test("no line ever contains the key", async () => {
    const stored = scenario();
    const missing = scenario({ credential: null, loginOutcome: { status: "ABORTED" } });

    const first = await runSetup(stored.ports, { ...REQUEST, yes: true, init: true });
    const second = await runSetup(missing.ports, { ...REQUEST, yes: true, init: true });

    expect([...first.lines, ...second.lines].join("\n")).not.toContain(SENTINEL_KEY);
  });
});

describe("runSetup agent delivery step", () => {
  test("interactive without the flag asks and a yes writes the user config", async () => {
    const { ports, memory, questions } = scenario({ answer: { status: "CONFIRMED" } });

    await runSetup(ports, REQUEST);

    expect(questions).toContain(
      `Let OpenCode deliver JevGuard findings and the fix strategy to the agent automatically (delivery: agent, written to ${normalize(OPENCODE_CONFIG)})?`,
    );
    expect(memory.store.get(OPENCODE_CONFIG)).toContain("delivery: agent");
  });

  test("interactive without the flag asks and a no does not write", async () => {
    const { ports, memory } = scenario({ answer: { status: "DECLINED" } });

    await runSetup(ports, REQUEST);

    expect(memory.store.has(OPENCODE_CONFIG)).toBe(false);
  });

  test("--yes without --agent-delivery does not write it", async () => {
    const { ports, memory } = scenario();

    await runSetup(ports, { ...REQUEST, yes: true });

    expect(memory.store.has(OPENCODE_CONFIG)).toBe(false);
  });

  test("--yes --agent-delivery writes only the selected host's file", async () => {
    const { ports, memory } = scenario();

    const result = await runSetup(ports, { ...REQUEST, yes: true, agentDelivery: true });

    expect(result.status).toBe("APPLIED");
    expect(memory.store.get(OPENCODE_CONFIG)).toContain("delivery: agent");
    expect(memory.store.has(CLAUDE_CONFIG)).toBe(false);
  });
});
