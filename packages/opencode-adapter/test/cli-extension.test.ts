import { join } from "node:path";
import type {
  ConfirmationPrompt,
  HostCliContext,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  TextFileSystem,
} from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import { createOpenCodeCliExtension } from "../src/cli";

const CWD = join("C:", "repo");
const HOME = join("C:", "home");
const GLOBAL_PATH = join(HOME, ".config", "opencode", "opencode.json");
const PROJECT_PATH = join(CWD, "opencode.json");
const PLUGIN = "@pablozrrrr/jevguard";

class FakeFiles implements TextFileSystem {
  readonly store = new Map<string, string>();
  readonly writes: string[] = [];

  readText = async (path: string): Promise<string | null> => this.store.get(path) ?? null;

  exists = async (path: string): Promise<boolean> => this.store.has(path);

  writeTextAtomic = async (path: string, text: string): Promise<void> => {
    this.writes.push(path);
    this.store.set(path, text);
  };

  makeDirectory = async (): Promise<void> => {};
}

class FakeProcesses implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];

  constructor(private readonly result: ProcessResult) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);

    return this.result;
  }
}

function confirmationOf(status: "CONFIRMED" | "DECLINED" | "NOT_A_TTY"): ConfirmationPrompt {
  return {
    confirm: async () =>
      status === "NOT_A_TTY" ? { status: "FAILED", reason: "NOT_A_TTY" } : { status },
  };
}

function exited(stdout: string): ProcessResult {
  return { kind: "EXITED", exitCode: 0, stdout };
}

function registered(...plugins: readonly string[]): string {
  return JSON.stringify({ plugin: plugins });
}

interface ContextOptions {
  files?: FakeFiles;
  processes?: ProcessRunner;
  confirmation?: ConfirmationPrompt;
}

function contextOf(options: ContextOptions = {}): HostCliContext {
  return {
    cwd: CWD,
    projectRoot: CWD,
    homedir: HOME,
    environment: { xdgConfigHome: undefined, userProfile: undefined, home: HOME },
    variable: () => undefined,
    processes: options.processes ?? new FakeProcesses(exited("2.2.2\n")),
    files: options.files ?? new FakeFiles(),
    confirmation: options.confirmation ?? confirmationOf("CONFIRMED"),
  };
}

const extension = createOpenCodeCliExtension();

describe("OpenCode CLI extension identity", () => {
  test("declares its host, config file, scopes and remediation rules", () => {
    expect(extension).toMatchObject({
      id: "opencode",
      displayName: "OpenCode",
      userConfigFileName: "opencode.yaml",
      remediationRules: {},
    });
  });
});

describe("OpenCode CLI extension detect", () => {
  test.each([
    ["2.2.2\n", "SUPPORTED", "2.2.2"],
    ["2.1.1", "UNSUPPORTED", "2.1.1"],
    ["2.3.0", "UNSUPPORTED", "2.3.0"],
  ] as const)("classifies %j", async (stdout, status, version) => {
    const processes = new FakeProcesses(exited(stdout));

    const detection = await extension.detect(contextOf({ processes }));

    expect(detection).toMatchObject({ host: "opencode", status, version });
    expect(detection.supportedRange).toContain(">=2.2.2");
    expect(processes.requests).toEqual([
      { command: "opencode", args: ["--version"], timeoutMs: 5_000 },
    ]);
  });

  test("reports a missing command and an unreadable version apart", async () => {
    const missing = await extension.detect(
      contextOf({ processes: new FakeProcesses({ kind: "NOT_FOUND" }) }),
    );
    const unreadable = await extension.detect(
      contextOf({ processes: new FakeProcesses(exited("no version")) }),
    );

    expect(missing).toMatchObject({ status: "NOT_FOUND", version: null });
    expect(unreadable).toMatchObject({ status: "UNKNOWN_VERSION", version: null });
  });
});

describe("OpenCode CLI extension inspectInstall", () => {
  test("maps the registration state and returns the config path", async () => {
    const files = new FakeFiles();
    files.store.set(GLOBAL_PATH, registered(PLUGIN));

    const global = await extension.inspectInstall(contextOf({ files }), "global");
    const project = await extension.inspectInstall(contextOf({ files }), "project");

    expect(global).toEqual({ state: "INSTALLED", target: GLOBAL_PATH });
    expect(project).toEqual({ state: "NOT_INSTALLED", target: PROJECT_PATH });
  });

  test("an unreadable document is UNKNOWN", async () => {
    const files = new FakeFiles();
    files.store.set(PROJECT_PATH, "{");

    expect(await extension.inspectInstall(contextOf({ files }), "project")).toEqual({
      state: "UNKNOWN",
      target: PROJECT_PATH,
    });
  });
});

describe("OpenCode CLI extension install", () => {
  test("registers the plugin and asks the user to restart OpenCode", async () => {
    const files = new FakeFiles();

    const outcome = await extension.install(contextOf({ files }), "global");

    expect(outcome).toMatchObject({ status: "CHANGED", code: "INSTALLED" });
    expect(outcome.lines.join("\n")).toContain(GLOBAL_PATH);
    expect(files.writes).toHaveLength(1);
  });

  test("leaves an already registered config unchanged", async () => {
    const files = new FakeFiles();
    files.store.set(PROJECT_PATH, registered(PLUGIN));

    const outcome = await extension.install(contextOf({ files }), "project");

    expect(outcome).toMatchObject({ status: "UNCHANGED", code: "ALREADY_INSTALLED" });
    expect(outcome.lines.join("\n")).toContain("already registered");
    expect(files.writes).toEqual([]);
  });

  test("a declined confirmation is DECLINED and writes nothing", async () => {
    const files = new FakeFiles();
    files.store.set(PROJECT_PATH, registered("other"));

    const outcome = await extension.install(
      contextOf({ files, confirmation: confirmationOf("DECLINED") }),
      "project",
    );

    expect(outcome).toMatchObject({ status: "DECLINED", code: "ABORTED" });
    expect(outcome.lines.join("\n")).toContain("Install cancelled");
    expect(files.writes).toEqual([]);
  });

  test("prints the manual snippet when no terminal can confirm", async () => {
    const files = new FakeFiles();
    files.store.set(PROJECT_PATH, registered("other"));

    const outcome = await extension.install(
      contextOf({ files, confirmation: confirmationOf("NOT_A_TTY") }),
      "project",
    );

    expect(outcome).toMatchObject({ status: "FAILED", code: "NOT_A_TTY" });
    expect(outcome.lines.join("\n")).toContain(PLUGIN);
    expect(files.writes).toEqual([]);
  });
});

describe("OpenCode CLI extension doctor", () => {
  async function doctor(files: FakeFiles, processes: ProcessRunner) {
    return extension.doctor(contextOf({ files, processes }));
  }

  test("returns the plugin and version checks with the documented JSON keys", async () => {
    const files = new FakeFiles();
    files.store.set(PROJECT_PATH, registered(PLUGIN));

    const checks = await doctor(files, new FakeProcesses(exited("2.2.2\n")));

    expect(checks.map((check) => check.json.id)).toEqual(["opencode-plugin", "opencode-version"]);
    expect(Object.keys(checks[0]?.json ?? {})).toEqual(["id", "status", "code", "targets"]);
    expect(checks[0]?.json).toMatchObject({ status: "OK", code: "REGISTERED" });
    expect(checks[1]?.json).toEqual({
      id: "opencode-version",
      status: "OK",
      code: "VERSION_SUPPORTED",
      version: "2.2.2",
    });
  });

  test("warns when no target is registered and shows both paths", async () => {
    const [plugin] = await doctor(new FakeFiles(), new FakeProcesses(exited("2.2.2")));

    expect(plugin?.json).toMatchObject({ status: "WARN", code: "NOT_REGISTERED" });
    expect(`${plugin?.message}\n${plugin?.annotation}`).toContain(GLOBAL_PATH);
    expect(`${plugin?.message}\n${plugin?.annotation}`).toContain(PROJECT_PATH);
  });

  test("warns when a target cannot be inspected", async () => {
    const files = new FakeFiles();
    files.store.set(PROJECT_PATH, "{");

    const [plugin] = await doctor(files, new FakeProcesses(exited("2.2.2")));

    expect(plugin?.json).toMatchObject({ status: "WARN", code: "INSPECTION_FAILED" });
  });

  test.each([
    ["2.2.2\n", "OK", "VERSION_SUPPORTED", "2.2.2"],
    ["2.2.7", "OK", "VERSION_SUPPORTED", "2.2.7"],
    ["2.1.1", "FAIL", "VERSION_UNSUPPORTED", "2.1.1"],
    ["2.3.0", "FAIL", "VERSION_UNSUPPORTED", "2.3.0"],
  ] as const)("classifies the version output %j", async (stdout, status, code, version) => {
    const [, versionCheck] = await doctor(new FakeFiles(), new FakeProcesses(exited(stdout)));

    expect(versionCheck?.json).toEqual({ id: "opencode-version", status, code, version });
  });

  test.each([
    [{ kind: "NOT_FOUND" } as ProcessResult],
    [{ kind: "TIMED_OUT" } as ProcessResult],
    [{ kind: "EXITED", exitCode: 1, stdout: "2.2.2" } as ProcessResult],
  ])("an unreadable version (%j) is a VERSION_UNKNOWN warning", async (result) => {
    const [, versionCheck] = await doctor(new FakeFiles(), new FakeProcesses(result));

    expect(versionCheck?.json).toEqual({
      id: "opencode-version",
      status: "WARN",
      code: "VERSION_UNKNOWN",
      version: null,
    });
  });

  test("names the supported range when the version is unsupported", async () => {
    const [, versionCheck] = await doctor(new FakeFiles(), new FakeProcesses(exited("2.1.1")));

    const text = `${versionCheck?.message}\n${versionCheck?.annotation}`;

    expect(text).toContain("OpenCode 2.1.1 is not supported.");
    expect(text).toContain(">=2.2.2 <2.3");
  });
});
