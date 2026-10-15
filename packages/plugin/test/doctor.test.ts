import { join } from "node:path";
import type {
  CredentialProvider,
  CredentialResolution,
  PolicyLoader,
  PolicyLoadResult,
} from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/node-infra";
import type { InstallInspection, InstallTarget } from "@jevguard/opencode-adapter";
import { describe, expect, test } from "vitest";
import { diagnose } from "../src/cli/doctor/diagnose";
import { describeDoctorReport, serializeDoctorReport } from "../src/cli/doctor/messages";
import type { DoctorCheck, DoctorReport } from "../src/cli/doctor/types";

const ROOT = join("C:", "repo");
const KEY_SENTINEL = "sk-DOCTOR-SENTINEL";
const DESCRIPTION_SENTINEL = "DESCRIPTION-SENTINEL-TEXT";
const GLOBAL_PATH = join("C:", "home", ".config", "opencode", "opencode.json");
const PROJECT_PATH = join(ROOT, "opencode.json");

class FakeCredentials implements CredentialProvider {
  constructor(private readonly outcome: CredentialResolution | Error) {}

  async resolve(): Promise<CredentialResolution> {
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    return this.outcome;
  }
}

class FakePolicy implements PolicyLoader {
  constructor(private readonly outcome: PolicyLoadResult | Error) {}

  async load(): Promise<PolicyLoadResult> {
    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    return this.outcome;
  }
}

function rule(id: string, extra: readonly string[] = []): string {
  return [
    `## ${id}`,
    "",
    ...extra,
    "",
    "### Rule",
    "",
    DESCRIPTION_SENTINEL,
    "",
    "### Violation",
    "",
    "The change violates the rule.",
  ].join("\n");
}

const validRule = (id: string) => rule(id, ["severity: error"]);

function loaded(rules: string | null, config: string | null = null): PolicyLoadResult {
  return { status: "LOADED", source: { rules, config } };
}

function registration(
  global: InstallInspection["status"],
  project: InstallInspection["status"] = "NOT_REGISTERED",
): (target: InstallTarget) => Promise<InstallInspection> {
  return async (target) => {
    const path = target === "global" ? GLOBAL_PATH : PROJECT_PATH;
    const status = target === "global" ? global : project;

    return status === "FAILED"
      ? { status, target, path, reason: "INVALID_JSON" }
      : { status, target, path };
  };
}

interface Overrides {
  credentials?: CredentialResolution | Error;
  policy?: PolicyLoadResult | Error;
  inspect?: (target: InstallTarget) => Promise<InstallInspection>;
}

function run(overrides: Overrides = {}): Promise<DoctorReport> {
  return diagnose({
    projectRoot: ROOT,
    credentials: new FakeCredentials(
      overrides.credentials ?? { status: "AVAILABLE", source: "STORE", apiKey: KEY_SENTINEL },
    ),
    policy: new FakePolicy(overrides.policy ?? loaded(validRule("ARCH-001"))),
    parseConfig: parsePolicyConfig,
    inspectOpenCode: overrides.inspect ?? registration("REGISTERED"),
  });
}

function check<Id extends DoctorCheck["id"]>(
  report: DoctorReport,
  id: Id,
): Extract<DoctorCheck, { id: Id }> {
  const found = report.checks.find(
    (candidate): candidate is Extract<DoctorCheck, { id: Id }> => candidate.id === id,
  );

  if (found === undefined) {
    throw new Error(`missing check ${id}`);
  }

  return found;
}

describe("doctor credential check", () => {
  test.each([
    [
      "the OS store",
      { status: "AVAILABLE", source: "STORE", apiKey: KEY_SENTINEL } as const,
      "OK",
      "CREDENTIAL_STORE",
    ],
    [
      "the environment override",
      { status: "AVAILABLE", source: "ENVIRONMENT", apiKey: KEY_SENTINEL } as const,
      "OK",
      "CREDENTIAL_ENVIRONMENT",
    ],
    [
      "a missing credential",
      { status: "UNAVAILABLE", reason: "MISSING_CREDENTIAL" } as const,
      "FAIL",
      "MISSING_CREDENTIAL",
    ],
    [
      "a store read failure",
      { status: "UNAVAILABLE", reason: "STORE_READ_FAILURE" } as const,
      "FAIL",
      "STORE_READ_FAILURE",
    ],
    ["a provider that throws", new Error(KEY_SENTINEL), "FAIL", "STORE_READ_FAILURE"],
  ])("maps %s", async (_name, credentials, status, code) => {
    const report = await run({ credentials });

    expect(check(report, "credential")).toEqual({ id: "credential", status, code });
  });

  test("never exposes the key or any part of it in either output", async () => {
    const report = await run();

    for (const output of [describeDoctorReport(report), serializeDoctorReport(report)]) {
      expect(output).not.toContain(KEY_SENTINEL);
      expect(output).not.toContain("sk-");
    }
  });

  test("never exposes the text of a thrown credential error", async () => {
    const report = await run({ credentials: new Error(KEY_SENTINEL) });

    expect(describeDoctorReport(report)).not.toContain(KEY_SENTINEL);
    expect(serializeDoctorReport(report)).not.toContain(KEY_SENTINEL);
  });
});

describe("doctor rules check", () => {
  test("lists the rule ids of a valid document", async () => {
    const policy = loaded([validRule("ARCH-001"), validRule("TEST-001")].join("\n\n"));

    const report = await run({ policy });
    const rules = check(report, "rules");

    expect(rules).toMatchObject({ status: "OK", code: "RULES_VALID" });
    expect(rules.ruleIds).toEqual(["ARCH-001", "TEST-001"]);
    expect(describeDoctorReport(report)).toContain("Rules: ARCH-001, TEST-001");
  });

  test("reports invalid rules as id and code pairs", async () => {
    const policy = loaded([validRule("ARCH-001"), rule("ARCH-002")].join("\n\n"));

    const report = await run({ policy });
    const rules = check(report, "rules");

    expect(rules).toMatchObject({ status: "FAIL", code: "RULES_INVALID" });
    expect(rules.ruleIds).toEqual(["ARCH-001"]);
    expect(rules.invalidRules).toEqual([{ ruleId: "ARCH-002", code: "MISSING_SEVERITY" }]);
    expect(describeDoctorReport(report)).toContain("ARCH-002 (MISSING_SEVERITY)");
  });

  test("renders a block without a usable id as <no id>", async () => {
    const report = await run({ policy: loaded("no headings here") });

    expect(describeDoctorReport(report)).toContain("<no id> (MISSING_ID)");
  });

  test("reports absent rules", async () => {
    const report = await run({ policy: loaded(null) });

    expect(check(report, "rules")).toMatchObject({ status: "FAIL", code: "RULES_MISSING" });
  });

  test.each([
    ["a rules read failure", { status: "FAILED", reason: "RULES_READ_FAILURE" } as const],
    ["a rejected loader", new Error("boom")],
  ])("%s fails rules and leaves config unchecked", async (_name, policy) => {
    const report = await run({ policy });

    expect(check(report, "rules")).toMatchObject({ status: "FAIL", code: "RULES_READ_FAILURE" });
    expect(check(report, "config")).toMatchObject({ status: "WARN", code: "CONFIG_NOT_CHECKED" });
  });

  test("a config read failure fails config and leaves rules unchecked", async () => {
    const report = await run({ policy: { status: "FAILED", reason: "CONFIG_READ_FAILURE" } });

    expect(check(report, "config")).toMatchObject({ status: "FAIL", code: "CONFIG_READ_FAILURE" });
    expect(check(report, "rules")).toMatchObject({ status: "WARN", code: "RULES_NOT_CHECKED" });
  });

  test("never prints rule description text", async () => {
    const report = await run();

    expect(describeDoctorReport(report)).not.toContain(DESCRIPTION_SENTINEL);
    expect(serializeDoctorReport(report)).not.toContain(DESCRIPTION_SENTINEL);
  });
});

const THRESHOLDS = [
  "version: 1",
  "thresholds:",
  "  error:",
  "    warn: 0.4",
  "    fail: 0.7",
  "  warning:",
  "    warn: 0.6",
  "",
].join("\n");

describe("doctor config check", () => {
  const rules = validRule("ARCH-001");

  test.each([
    ["absent config", null, "OK", "CONFIG_DEFAULTS"],
    ["a valid config", THRESHOLDS, "OK", "CONFIG_VALID"],
    ["YAML with an alias", "a: &x 1\nb: *x\n", "FAIL", "CONFIG_PARSE_INVALID"],
    [
      "warn at or above fail",
      "version: 1\nthresholds:\n  error:\n    warn: 0.9\n    fail: 0.5\n",
      "FAIL",
      "CONFIG_INVALID",
    ],
    [
      "an invalid remediation section",
      `${THRESHOLDS}remediation:\n  auto_propose: nope\n`,
      "FAIL",
      "REMEDIATION_INVALID",
    ],
  ])("classifies %s", async (_name, config, status, code) => {
    const report = await run({ policy: loaded(rules, config) });

    expect(check(report, "config")).toMatchObject({ status, code });
  });
});

describe("doctor OpenCode check", () => {
  test("is OK when either target is registered", async () => {
    const report = await run({ inspect: registration("NOT_REGISTERED", "REGISTERED") });

    expect(check(report, "opencode-plugin")).toMatchObject({ status: "OK", code: "REGISTERED" });
  });

  test("warns when no target is registered and shows both paths", async () => {
    const report = await run({ inspect: registration("NOT_REGISTERED") });

    expect(check(report, "opencode-plugin")).toMatchObject({
      status: "WARN",
      code: "NOT_REGISTERED",
    });
    expect(describeDoctorReport(report)).toContain(`${GLOBAL_PATH} or ${PROJECT_PATH}`);
  });

  test("warns when a target cannot be inspected", async () => {
    const report = await run({ inspect: registration("REGISTERED", "FAILED") });

    expect(check(report, "opencode-plugin")).toMatchObject({
      status: "WARN",
      code: "INSPECTION_FAILED",
    });
    expect(describeDoctorReport(report)).toContain(PROJECT_PATH);
  });
});

describe("doctor aggregate status", () => {
  test("is OK when every check is OK", async () => {
    const report = await run();

    expect(report.status).toBe("OK");
    expect(describeDoctorReport(report)).toContain("Result: OK (0 fail, 0 warn)");
  });

  test("is WARN when only warnings exist", async () => {
    const report = await run({ inspect: registration("NOT_REGISTERED") });

    expect(report.status).toBe("WARN");
  });

  test("is FAIL when any check fails and counts both kinds", async () => {
    const report = await run({
      credentials: { status: "UNAVAILABLE", reason: "MISSING_CREDENTIAL" },
      inspect: registration("NOT_REGISTERED"),
    });

    expect(report.status).toBe("FAIL");
    expect(describeDoctorReport(report)).toContain("Result: FAIL (1 fail, 1 warn)");
  });

  test("the JSON form round-trips the report", async () => {
    const report = await run({ policy: loaded(null) });

    expect(JSON.parse(serializeDoctorReport(report))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(report.version).toBe(1);
    expect(report.projectRoot).toBe(ROOT);
  });
});
