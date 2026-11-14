import type {
  ConfirmationPrompt,
  HostCliContext,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  TextFileSystem,
} from "@jevguard/node-infra";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createClaudeCodeCliExtension } from "../src/cli";

const PLUGIN_ID = "jevguard@jevguard";
const MARKETPLACE_ADD = "plugin marketplace add pablozr/JevGuard --scope";

type Responder = (request: ProcessRequest) => ProcessResult;

class FakeProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];

  constructor(private readonly responder: Responder) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);

    return this.responder(request);
  }

  commands(): string[] {
    return this.requests.map((request) => request.args.join(" "));
  }
}

function exited(stdout: string, exitCode = 0): ProcessResult {
  return { kind: "EXITED", exitCode, stdout };
}

function confirmationOf(status: "CONFIRMED" | "DECLINED" | "NOT_A_TTY"): ConfirmationPrompt {
  return {
    confirm: async () =>
      status === "NOT_A_TTY" ? { status: "FAILED", reason: "NOT_A_TTY" } : { status },
  };
}

const unusedFiles: TextFileSystem = {
  readText: async () => null,
  exists: async () => false,
  writeTextAtomic: async () => {
    throw new Error("the Claude Code extension must not write files itself");
  },
  makeDirectory: async () => {},
};

function contextOf(
  processes: ProcessRunner,
  confirmation: ConfirmationPrompt = confirmationOf("CONFIRMED"),
  variables: Readonly<Record<string, string>> = {},
): HostCliContext {
  return {
    cwd: "C:/repo",
    projectRoot: "C:/repo",
    homedir: "C:/home",
    environment: { xdgConfigHome: undefined, userProfile: undefined, home: "C:/home" },
    variable: (name) => variables[name],
    processes,
    files: unusedFiles,
    confirmation,
  };
}

interface Machine {
  version?: string;
  node?: string;
  plugins?: readonly { id: string; scope: string; enabled?: boolean }[];
  marketplaces?: readonly { name: string }[];
  failing?: readonly string[];
}

function machine(options: Machine = {}): FakeProcesses {
  const {
    version = "2.1.322 (Claude Code)",
    node = "v22.14.0",
    plugins = [],
    marketplaces = [],
    failing = [],
  } = options;

  return new FakeProcesses((request) => {
    const command = request.args.join(" ");

    if (request.command === "node") return exited(`${node}\n`);

    if (failing.some((prefix) => command.startsWith(prefix))) return exited("", 1);

    if (command === "--version") return exited(`${version}\n`);

    if (command === "plugin list --json") return exited(JSON.stringify(plugins));

    if (command === "plugin marketplace list --json") return exited(JSON.stringify(marketplaces));

    return exited("");
  });
}

const extension = createClaudeCodeCliExtension();

describe("Claude Code CLI extension identity", () => {
  test("declares its host, config file, scopes and the Claude model rule", () => {
    expect(extension).toMatchObject({
      id: "claude-code",
      displayName: "Claude Code",
      userConfigFileName: "claude-code.yaml",
    });
    expect(extension.remediationRules.isModel?.("claude-opus-4-5")).toBe(true);
    expect(extension.remediationRules.isModel?.("bad model")).toBe(false);
  });
});

describe("Claude Code CLI extension detect", () => {
  test.each([
    ["2.1.322 (Claude Code)", "SUPPORTED", "2.1.322"],
    ["2.1.287", "SUPPORTED", "2.1.287"],
    ["2.1.286", "UNSUPPORTED", "2.1.286"],
    ["1.9.0", "UNSUPPORTED", "1.9.0"],
  ] as const)("classifies %j", async (version, status, parsed) => {
    const processes = machine({ version });

    const detection = await extension.detect(contextOf(processes));

    expect(detection).toMatchObject({ host: "claude-code", status, version: parsed });
    expect(detection.supportedRange).toBe(">=2.1.287");
    expect(processes.requests[0]).toEqual({
      command: "claude",
      args: ["--version"],
      timeoutMs: 5_000,
    });
  });

  test("separates a missing command from an unreadable version", async () => {
    const missing = await extension.detect(
      contextOf(new FakeProcesses(() => ({ kind: "NOT_FOUND" }))),
    );
    const unreadable = await extension.detect(contextOf(machine({ version: "no version" })));

    expect(missing).toMatchObject({ status: "NOT_FOUND", version: null });
    expect(unreadable).toMatchObject({ status: "UNKNOWN_VERSION", version: null });
  });
});

describe("Claude Code CLI extension inspectInstall", () => {
  const installed = [{ id: PLUGIN_ID, scope: "user" }];

  test("maps the plugin list to the scope asked for", async () => {
    const processes = machine({ plugins: installed });

    const global = await extension.inspectInstall(contextOf(processes), "global");
    const project = await extension.inspectInstall(contextOf(processes), "project");

    expect(global.state).toBe("INSTALLED");
    expect(project.state).toBe("NOT_INSTALLED");
    expect(global.target).toContain("user scope");
  });

  test("ignores a different plugin with the same scope", async () => {
    const processes = machine({ plugins: [{ id: "other@jevguard", scope: "user" }] });

    expect((await extension.inspectInstall(contextOf(processes), "global")).state).toBe(
      "NOT_INSTALLED",
    );
  });

  test.each([
    ["a failing list", machine({ failing: ["plugin list"] })],
    ["unparseable output", new FakeProcesses(() => exited("not json"))],
    ["a non-array document", new FakeProcesses(() => exited("{}"))],
  ])("is UNKNOWN for %s", async (_label, processes) => {
    expect((await extension.inspectInstall(contextOf(processes), "global")).state).toBe("UNKNOWN");
  });
});

describe("Claude Code CLI extension install", () => {
  test("adds the marketplace, installs the plugin and asks for a new session", async () => {
    const processes = machine();

    const outcome = await extension.install(contextOf(processes), "global");

    expect(outcome).toMatchObject({ status: "CHANGED", code: "INSTALLED" });
    expect(outcome.lines.join("\n")).toContain("Start a new Claude Code session");
    expect(processes.commands().slice(-2)).toEqual([
      `${MARKETPLACE_ADD} user`,
      `plugin install ${PLUGIN_ID} --scope user`,
    ]);
  });

  test("names the default config dir without CLAUDE_CONFIG_DIR", async () => {
    const questions: string[] = [];
    const confirmation: ConfirmationPrompt = {
      confirm: async (message) => {
        questions.push(message);

        return { status: "CONFIRMED" };
      },
    };

    const outcome = await extension.install(contextOf(machine(), confirmation), "global");

    expect(questions.join("\n")).toContain(join("C:/home", ".claude"));
    expect(outcome.lines.join("\n")).toContain(join("C:/home", ".claude"));
  });

  test("with CLAUDE_CONFIG_DIR it installs for that dir, names it and writes no file itself", async () => {
    const dir = "C:/agents/accounts/one";
    const questions: string[] = [];
    const confirmation: ConfirmationPrompt = {
      confirm: async (message) => {
        questions.push(message);

        return { status: "CONFIRMED" };
      },
    };
    const processes = machine();

    const outcome = await extension.install(
      contextOf(processes, confirmation, { CLAUDE_CONFIG_DIR: dir }),
      "global",
    );

    expect(outcome).toMatchObject({ status: "CHANGED", code: "INSTALLED" });
    expect(questions.join("\n")).toContain(dir);
    expect(outcome.lines.join("\n")).toContain(dir);
    expect(outcome.lines.join("\n")).not.toContain(".claude");
    expect(processes.commands().slice(-1)).toEqual([`plugin install ${PLUGIN_ID} --scope user`]);
  });

  test("uses the project scope for --project", async () => {
    const processes = machine();

    await extension.install(contextOf(processes), "project");

    expect(processes.commands().slice(-1)).toEqual([`plugin install ${PLUGIN_ID} --scope project`]);
  });

  test("skips the marketplace add when the marketplace is configured", async () => {
    const processes = machine({ marketplaces: [{ name: "jevguard" }] });

    await extension.install(contextOf(processes), "global");

    expect(processes.commands().some((command) => command.includes("marketplace add"))).toBe(false);
  });

  test("leaves an installed plugin unchanged and runs no installer", async () => {
    const processes = machine({ plugins: [{ id: PLUGIN_ID, scope: "user" }] });

    const outcome = await extension.install(contextOf(processes), "global");

    expect(outcome).toMatchObject({ status: "UNCHANGED", code: "ALREADY_INSTALLED" });
    expect(processes.commands().some((command) => command.startsWith("plugin install"))).toBe(
      false,
    );
  });

  test("a declined confirmation runs nothing", async () => {
    const processes = machine();

    const outcome = await extension.install(
      contextOf(processes, confirmationOf("DECLINED")),
      "global",
    );

    expect(outcome).toMatchObject({ status: "DECLINED", code: "ABORTED" });
    expect(processes.commands().some((command) => command.includes("install"))).toBe(false);
  });

  test("without a terminal it prints the manual commands and runs nothing", async () => {
    const processes = machine();

    const outcome = await extension.install(
      contextOf(processes, confirmationOf("NOT_A_TTY")),
      "global",
    );

    expect(outcome).toMatchObject({ status: "FAILED", code: "NOT_A_TTY" });
    expect(outcome.lines.join("\n")).toContain(`claude plugin install ${PLUGIN_ID} --scope user`);
    expect(processes.commands().some((command) => command.includes("marketplace add"))).toBe(false);
  });

  test("a missing or unsupported Claude Code fails before asking anything", async () => {
    const missing = await extension.install(
      contextOf(new FakeProcesses(() => ({ kind: "NOT_FOUND" }))),
      "global",
    );
    const old = await extension.install(contextOf(machine({ version: "2.0.0" })), "global");

    expect(missing).toMatchObject({ status: "FAILED", code: "CLAUDE_NOT_FOUND" });
    expect(old).toMatchObject({ status: "FAILED", code: "VERSION_UNSUPPORTED" });
    expect(old.lines.join("\n")).toContain(">=2.1.287");
  });

  test.each([
    ["plugin marketplace add", "MARKETPLACE_FAILED"],
    ["plugin install", "INSTALL_FAILED"],
  ])("a failing %s is %s with the manual commands", async (failing, code) => {
    const outcome = await extension.install(contextOf(machine({ failing: [failing] })), "global");

    expect(outcome).toMatchObject({ status: "FAILED", code });
    expect(outcome.lines.join("\n")).toContain("claude plugin install");
  });
});

describe("Claude Code CLI extension doctor", () => {
  test("returns the plugin and version checks with the documented JSON keys", async () => {
    const processes = machine({ plugins: [{ id: PLUGIN_ID, scope: "project" }] });

    const checks = await extension.doctor(contextOf(processes));

    expect(checks.map((check) => check.json.id)).toEqual([
      "claude-plugin",
      "claude-version",
      "claude-config",
      "claude-node",
    ]);
    expect(Object.keys(checks[0]?.json ?? {})).toEqual(["id", "status", "code", "scopes"]);
    expect(checks[0]?.json).toEqual({
      id: "claude-plugin",
      status: "OK",
      code: "INSTALLED",
      scopes: [
        { scope: "global", state: "NOT_INSTALLED" },
        { scope: "project", state: "INSTALLED" },
      ],
    });
    expect(checks[1]?.json).toEqual({
      id: "claude-version",
      status: "OK",
      code: "VERSION_SUPPORTED",
      version: "2.1.322",
    });
  });

  test("reports the default config dir and the Node version", async () => {
    const [, , config, node] = await extension.doctor(contextOf(machine()));

    expect(config?.json).toEqual({
      id: "claude-config",
      status: "OK",
      code: "CONFIG_DIR_DEFAULT",
      configDir: join("C:/home", ".claude"),
    });
    expect(node?.json).toEqual({
      id: "claude-node",
      status: "OK",
      code: "VERSION_SUPPORTED",
      version: "22.14.0",
    });
  });

  test("names the CLAUDE_CONFIG_DIR in use in the plugin and config checks", async () => {
    const dir = "C:/agents/accounts/one";
    const processes = machine({ plugins: [{ id: PLUGIN_ID, scope: "user" }] });

    const [plugin, , config] = await extension.doctor(
      contextOf(processes, confirmationOf("CONFIRMED"), { CLAUDE_CONFIG_DIR: dir }),
    );

    expect(plugin?.message).toContain(dir);
    expect(plugin?.json).toMatchObject({ status: "OK", code: "INSTALLED" });
    expect(config?.json).toMatchObject({ code: "CONFIG_DIR_OVERRIDE", configDir: dir });
    expect(config?.message).toContain("from CLAUDE_CONFIG_DIR");
  });

  test("an empty CLAUDE_CONFIG_DIR falls back to the default", async () => {
    const [, , config] = await extension.doctor(
      contextOf(machine(), confirmationOf("CONFIRMED"), { CLAUDE_CONFIG_DIR: "  " }),
    );

    expect(config?.json).toMatchObject({ code: "CONFIG_DIR_DEFAULT" });
  });

  test("warns when the plugin is installed but disabled", async () => {
    const processes = machine({ plugins: [{ id: PLUGIN_ID, scope: "user", enabled: false }] });

    const [plugin] = await extension.doctor(contextOf(processes));

    expect(plugin?.json).toMatchObject({ status: "WARN", code: "DISABLED" });
    expect(plugin?.annotation).toContain(`claude plugin enable ${PLUGIN_ID}`);
  });

  test.each([
    ["v22.13.0", "OK", "VERSION_SUPPORTED"],
    ["v22.12.9", "FAIL", "VERSION_UNSUPPORTED"],
    ["v20.11.1", "FAIL", "VERSION_UNSUPPORTED"],
  ] as const)("classifies the Node version %s", async (node, status, code) => {
    const [, , , check] = await extension.doctor(contextOf(machine({ node })));

    expect(check?.json).toMatchObject({ id: "claude-node", status, code });
  });

  test("a missing Node is a warning with the range", async () => {
    const processes = new FakeProcesses((request) =>
      request.command === "node" ? { kind: "NOT_FOUND" } : exited("2.1.322 (Claude Code)\n"),
    );

    const [, , , check] = await extension.doctor(contextOf(processes));

    expect(check?.json).toMatchObject({ id: "claude-node", status: "WARN" });
  });

  test("never prints settings content or a credential", async () => {
    const processes = machine({ plugins: [{ id: PLUGIN_ID, scope: "user" }] });
    const checks = await extension.doctor(
      contextOf(processes, confirmationOf("CONFIRMED"), {
        CLAUDE_CONFIG_DIR: "C:/cfg",
        TYPESAFE_API_KEY: "tsk_SECRET_VALUE",
      }),
    );

    expect(JSON.stringify(checks)).not.toContain("tsk_SECRET_VALUE");
  });

  test("warns and names the install command when the plugin is absent", async () => {
    const [plugin] = await extension.doctor(contextOf(machine()));

    expect(plugin?.json).toMatchObject({ status: "WARN", code: "NOT_INSTALLED" });
    expect(plugin?.annotation).toContain("jevguard install --host claude-code");
  });

  test("warns when the plugin list cannot be read", async () => {
    const [plugin] = await extension.doctor(contextOf(machine({ failing: ["plugin list"] })));

    expect(plugin?.json).toMatchObject({ status: "WARN", code: "INSPECTION_FAILED" });
  });

  test.each([
    ["2.1.322 (Claude Code)", "OK", "VERSION_SUPPORTED", "2.1.322"],
    ["2.1.286", "FAIL", "VERSION_UNSUPPORTED", "2.1.286"],
    ["garbage", "WARN", "VERSION_UNKNOWN", null],
  ] as const)("classifies the version output %j", async (version, status, code, parsed) => {
    const [, check] = await extension.doctor(contextOf(machine({ version })));

    expect(check?.json).toEqual({ id: "claude-version", status, code, version: parsed });
  });

  test("names the supported range when unsupported", async () => {
    const [, check] = await extension.doctor(contextOf(machine({ version: "2.1.286" })));

    expect(check?.message).toContain("Claude Code 2.1.286 is not supported.");
    expect(check?.annotation).toContain(">=2.1.287");
  });
});
