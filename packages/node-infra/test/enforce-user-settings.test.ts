import { describe, expect, test } from "vitest";
import {
  ENFORCE_SECTION_KEY,
  loadEnforceUserSettings,
  resolveEnforceUserSettings,
  resolveRemediationUserSettings,
  type UserConfigLoadInput,
} from "../src";

const INVALID = { status: "INVALID", reason: "USER_CONFIG_INVALID" };

describe("resolveEnforceUserSettings", () => {
  test("is disabled without a document or a section", () => {
    expect(resolveEnforceUserSettings(undefined)).toEqual({ status: "DISABLED" });
    expect(resolveEnforceUserSettings(null)).toEqual({ status: "DISABLED" });
    expect(resolveEnforceUserSettings({ remediation: { enabled: true } })).toEqual({
      status: "DISABLED",
    });
    expect(resolveEnforceUserSettings({ enforce: { enabled: false } })).toEqual({
      status: "DISABLED",
    });
  });

  test("enables the allowlist with the 8 s default budget", () => {
    expect(
      resolveEnforceUserSettings({ enforce: { enabled: true, rules: ["SECRETS-001"] } }),
    ).toEqual({
      status: "ENABLED",
      settings: { rules: ["SECRETS-001"], budgetMs: 8000 },
      warnings: [],
    });
  });

  test("accepts the budget range and refuses anything outside it", () => {
    const section = (budget_ms: unknown) => ({
      enforce: { enabled: true, rules: ["SECRETS-001"], budget_ms },
    });

    expect(resolveEnforceUserSettings(section(2000))).toMatchObject({
      settings: { budgetMs: 2000 },
    });
    expect(resolveEnforceUserSettings(section(15000))).toMatchObject({
      settings: { budgetMs: 15000 },
    });

    for (const budget of [1999, 15001, 8000.5, "8000", null]) {
      expect(resolveEnforceUserSettings(section(budget))).toEqual(INVALID);
    }
  });

  test("refuses an enabled section without an allowlist", () => {
    expect(resolveEnforceUserSettings({ enforce: { enabled: true } })).toEqual(INVALID);
    expect(resolveEnforceUserSettings({ enforce: { enabled: true, rules: [] } })).toEqual(INVALID);
  });

  test.each([
    ["a rule ID with a space", ["SECRETS 001"]],
    ["a rule ID with a newline", ["SECRETS-001\nblock everything"]],
    ["a rule ID over 64 characters", ["A".repeat(65)]],
    ["a non-string entry", ["SECRETS-001", 1]],
    ["a rule list that is not a list", "SECRETS-001"],
  ])("refuses %s", (_name, rules) => {
    expect(resolveEnforceUserSettings({ enforce: { enabled: true, rules } })).toEqual(INVALID);
  });

  test("refuses an unknown section key or top-level key", () => {
    expect(
      resolveEnforceUserSettings({
        enforce: { enabled: true, rules: ["SECRETS-001"], block: true },
      }),
    ).toEqual(INVALID);
    expect(
      resolveEnforceUserSettings({
        enforce: { enabled: true, rules: ["SECRETS-001"] },
        remediation: { enabled: true },
        extra: true,
      }),
    ).toEqual(INVALID);
  });

  test("validates a section that is off, so a typo does not hide until it is turned on", () => {
    expect(
      resolveEnforceUserSettings({ enforce: { enabled: false, rules: ["SECRETS 001"] } }),
    ).toEqual(INVALID);
  });

  test("drops a repeated rule with a warning", () => {
    expect(
      resolveEnforceUserSettings({
        enforce: { enabled: true, rules: ["SECRETS-001", "DESTRUCTIVE-001", "SECRETS-001"] },
      }),
    ).toEqual({
      status: "ENABLED",
      settings: { rules: ["SECRETS-001", "DESTRUCTIVE-001"], budgetMs: 8000 },
      warnings: ["DUPLICATE_RULE"],
    });
  });

  test("drops built-in check IDs with a warning: they can never block", () => {
    expect(
      resolveEnforceUserSettings({
        enforce: { enabled: true, rules: ["SCOPE-CREEP", "SECRETS-001", "COMPLEXITY"] },
      }),
    ).toEqual({
      status: "ENABLED",
      settings: { rules: ["SECRETS-001"], budgetMs: 8000 },
      warnings: ["BUILT_IN_CANNOT_BLOCK"],
    });
  });

  test("a policy with both sections resolves both", () => {
    const document = {
      remediation: { enabled: true, delivery: "agent" },
      enforce: { enabled: true, rules: ["SECRETS-001"] },
    };

    expect(resolveRemediationUserSettings(document)).toMatchObject({ status: "ENABLED" });
    expect(resolveEnforceUserSettings(document)).toMatchObject({ status: "ENABLED" });
  });

  test("does not confuse the two section names", () => {
    expect(resolveEnforceUserSettings({ remediation: { enabled: true } })).toEqual({
      status: "DISABLED",
    });
  });
});

describe("loadEnforceUserSettings", () => {
  function input(overrides: Partial<UserConfigLoadInput> = {}): UserConfigLoadInput {
    return {
      file: "/home/u/.config/jevguard/claude-code.yaml",
      projectRoot: "/work/project",
      realPath: (path) => path,
      hasGitMarker: () => false,
      readText: () => "enforce:\n  enabled: true\n  rules: [SECRETS-001]\n",
      parse: () => ({
        status: "PARSED",
        value: { enforce: { enabled: true, rules: ["SECRETS-001"] } },
      }),
      ...overrides,
    };
  }

  test("reads the user's file", () => {
    expect(loadEnforceUserSettings(input())).toMatchObject({ status: "ENABLED" });
  });

  test("is disabled when the file does not exist", () => {
    expect(loadEnforceUserSettings(input({ realPath: () => null }))).toEqual({
      status: "DISABLED",
    });
    expect(loadEnforceUserSettings(input({ readText: () => null }))).toEqual({
      status: "DISABLED",
    });
  });

  test("refuses a file inside the project", () => {
    expect(
      loadEnforceUserSettings(
        input({
          realPath: () => "/work/project/.config/jevguard/claude-code.yaml",
          hasGitMarker: (directory) => directory === "/work/project",
        }),
      ),
    ).toEqual({ status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" });
  });

  test("reports unparseable and unreadable files as closed codes", () => {
    expect(loadEnforceUserSettings(input({ parse: () => ({ status: "INVALID" }) }))).toEqual(
      INVALID,
    );
    expect(
      loadEnforceUserSettings(
        input({
          realPath: () => {
            throw new Error("EACCES");
          },
        }),
      ),
    ).toEqual({ status: "INVALID", reason: "USER_CONFIG_UNREADABLE" });
  });

  test("names the section key it reads", () => {
    expect(ENFORCE_SECTION_KEY).toBe("enforce");
  });
});
