import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createUserRemediationSettings,
  resolveRemediationUserSettings,
  userConfigFileOf,
} from "../src";

const REMEDIATE = {
  status: "ENABLED",
  settings: { delivery: "agent", model: null, mode: "remediate", maxAttempts: 3 },
};

describe("resolveRemediationUserSettings", () => {
  test("refuses a model key when the host accepts no model", () => {
    expect(
      resolveRemediationUserSettings({ remediation: { enabled: true, model: "openai/gpt-5" } }),
    ).toEqual({ status: "INVALID", reason: "USER_CONFIG_INVALID" });
  });

  test("accepts the shared keys for remediate", () => {
    expect(
      resolveRemediationUserSettings({
        remediation: { enabled: true, delivery: "agent", mode: "remediate", max_attempts: 3 },
      }),
    ).toEqual(REMEDIATE);
  });

  test("asks the host whether a model is valid", () => {
    const rules = { isModel: (value: string) => value === "ok" };

    expect(
      resolveRemediationUserSettings({ remediation: { enabled: true, model: "ok" } }, rules),
    ).toMatchObject({ status: "ENABLED", settings: { model: "ok" } });
    expect(
      resolveRemediationUserSettings({ remediation: { enabled: true, model: "no" } }, rules),
    ).toEqual({ status: "INVALID", reason: "USER_CONFIG_INVALID" });
  });
});

describe("userConfigFileOf", () => {
  test("names the host's own file under jevguard/", () => {
    expect(
      userConfigFileOf(
        { xdgConfigHome: "/xdg", userProfile: undefined, home: undefined },
        "opencode.yaml",
      ),
    ).toBe("/xdg/jevguard/opencode.yaml");
    expect(
      userConfigFileOf(
        { xdgConfigHome: undefined, userProfile: "", home: "/home/u" },
        "opencode.yaml",
      ),
    ).toBe("/home/u/.config/jevguard/opencode.yaml");
    expect(
      userConfigFileOf(
        { xdgConfigHome: undefined, userProfile: undefined, home: "relative" },
        "opencode.yaml",
      ),
    ).toBeNull();
  });
});

describe("createUserRemediationSettings", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function scratch(): string {
    const directory = mkdtempSync(join(tmpdir(), "jevguard-user-settings-"));

    directories.push(directory);

    return directory;
  }

  test("reads the host's file outside the project and remembers it per project", () => {
    const config = scratch();
    const project = scratch();

    mkdirSync(join(config, "jevguard"));
    writeFileSync(
      join(config, "jevguard", "opencode.yaml"),
      "remediation:\n  enabled: true\n  delivery: agent\n  mode: remediate\n  max_attempts: 3\n",
    );

    const settingsOf = createUserRemediationSettings({
      environment: { get: (name) => (name === "XDG_CONFIG_HOME" ? config : undefined) },
      fileName: "opencode.yaml",
    });

    expect(settingsOf(project)).toEqual(REMEDIATE);

    rmSync(join(config, "jevguard", "opencode.yaml"));

    expect(settingsOf(project)).toEqual(REMEDIATE);
  });

  test("refuses a file inside the project", () => {
    const project = scratch();

    mkdirSync(join(project, "jevguard"));
    writeFileSync(join(project, "jevguard", "opencode.yaml"), "remediation:\n  enabled: true\n");

    const settingsOf = createUserRemediationSettings({
      environment: { get: (name) => (name === "XDG_CONFIG_HOME" ? project : undefined) },
      fileName: "opencode.yaml",
    });

    expect(settingsOf(project)).toEqual({ status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" });
  });

  test("is disabled when the file is absent", () => {
    const settingsOf = createUserRemediationSettings({
      environment: { get: (name) => (name === "XDG_CONFIG_HOME" ? scratch() : undefined) },
      fileName: "opencode.yaml",
    });

    expect(settingsOf(scratch())).toEqual({ status: "DISABLED" });
  });
});
