import { describe, expect, test } from "vitest";
import {
  loadClaudeRemediationSettings,
  resolveClaudeRemediationSettings,
  userConfigFileOf,
} from "../src/worker";

const ENABLED_USER = { status: "ENABLED", settings: { delivery: "user", model: null } };
const INVALID = { status: "INVALID", reason: "USER_CONFIG_INVALID" };

describe("resolveClaudeRemediationSettings", () => {
  test("absent configuration and an absent section are disabled", () => {
    expect(resolveClaudeRemediationSettings(null)).toEqual({ status: "DISABLED" });
    expect(resolveClaudeRemediationSettings(undefined)).toEqual({ status: "DISABLED" });
    expect(resolveClaudeRemediationSettings({})).toEqual({ status: "DISABLED" });
    expect(resolveClaudeRemediationSettings({ remediation: {} })).toEqual({ status: "DISABLED" });
  });

  test("enabled defaults to false and delivery to user", () => {
    expect(resolveClaudeRemediationSettings({ remediation: { delivery: "agent" } })).toEqual({
      status: "DISABLED",
    });
    expect(resolveClaudeRemediationSettings({ remediation: { enabled: true } })).toEqual(
      ENABLED_USER,
    );
  });

  test("enabled false is disabled whatever the delivery", () => {
    for (const delivery of ["user", "agent"]) {
      expect(
        resolveClaudeRemediationSettings({ remediation: { enabled: false, delivery } }),
      ).toEqual({ status: "DISABLED" });
    }
  });

  test("accepts the agent delivery and a Claude model", () => {
    expect(
      resolveClaudeRemediationSettings({
        remediation: { enabled: true, delivery: "agent", model: "claude-opus-5-5[1m]" },
      }),
    ).toEqual({
      status: "ENABLED",
      settings: { delivery: "agent", model: "claude-opus-5-5[1m]" },
    });
  });

  test("rejects unknown keys, wrong types, unknown deliveries and provider models", () => {
    const cases: unknown[] = [
      "text",
      [],
      { other: 1 },
      { remediation: null },
      { remediation: [] },
      { remediation: { enabled: true, extra: 1 } },
      { remediation: { enabled: "true" } },
      { remediation: { enabled: true, delivery: "AGENT" } },
      { remediation: { enabled: true, delivery: 1 } },
      { remediation: { enabled: true, model: "anthropic/x" } },
      { remediation: { enabled: true, model: 3 } },
      { remediation: { enabled: true, model: "a b" } },
      { remediation: { enabled: false, delivery: "other" } },
    ];

    for (const value of cases) expect(resolveClaudeRemediationSettings(value)).toEqual(INVALID);
  });
});

describe("userConfigFileOf", () => {
  test("prefers an absolute XDG_CONFIG_HOME", () => {
    expect(userConfigFileOf({ xdgConfigHome: "/cfg/", userProfile: "/u", home: "/h" })).toBe(
      "/cfg/jevguard/claude-code.yaml",
    );
  });

  test("ignores a relative XDG_CONFIG_HOME and prefers USERPROFILE over HOME", () => {
    expect(userConfigFileOf({ xdgConfigHome: "cfg", userProfile: "C:\\u", home: "/h" })).toBe(
      "C:\\u/.config/jevguard/claude-code.yaml",
    );
    expect(userConfigFileOf({ xdgConfigHome: undefined, userProfile: "", home: "/h" })).toBe(
      "/h/.config/jevguard/claude-code.yaml",
    );
  });

  test("is null without an absolute base", () => {
    expect(
      userConfigFileOf({ xdgConfigHome: undefined, userProfile: undefined, home: undefined }),
    ).toBeNull();
    expect(userConfigFileOf({ xdgConfigHome: "x", userProfile: "y", home: "z" })).toBeNull();
  });
});

describe("loadClaudeRemediationSettings", () => {
  const FILE = "/home/u/.config/jevguard/claude-code.yaml";
  const PARSED_ENABLED = { remediation: { enabled: true } };

  function load(overrides: Partial<Parameters<typeof loadClaudeRemediationSettings>[0]> = {}) {
    return loadClaudeRemediationSettings({
      file: FILE,
      projectRoot: "/work/project",
      readText: () => "text",
      realPath: (path) => path,
      hasGitMarker: () => false,
      parse: () => ({ status: "PARSED", value: PARSED_ENABLED }),
      ...overrides,
    });
  }

  test("a valid file outside the project is enabled", () => {
    expect(load()).toEqual(ENABLED_USER);
  });

  test("a missing file is disabled", () => {
    expect(load({ realPath: (path) => (path === FILE ? null : path) })).toEqual({
      status: "DISABLED",
    });
    expect(load({ readText: () => null })).toEqual({ status: "DISABLED" });
  });

  test("a file whose real path is inside the project is refused", () => {
    const refused = { status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" };

    expect(load({ projectRoot: "/home/u" })).toEqual(refused);
    expect(load({ realPath: (path) => (path === FILE ? "/work/project/x/c.yaml" : path) })).toEqual(
      refused,
    );
    expect(load({ projectRoot: "/home/u/.config/jevguard/claude-code.yaml" })).toEqual(refused);
  });

  test("a sibling directory with the same prefix is not inside the project", () => {
    expect(load({ projectRoot: "/home/u/.config/jevguard/claude" })).toEqual(ENABLED_USER);
  });

  test("paths compare without case or separator differences on every platform", () => {
    const refused = { status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" };
    const windows = {
      file: "C:\\Users\\Me\\.config\\jevguard\\claude-code.yaml",
      projectRoot: "c:/users/me",
    };

    expect(load(windows)).toEqual(refused);
    expect(load({ projectRoot: "/HOME/U" })).toEqual(refused);
  });

  test("a file inside the Git working tree but outside the project root is refused", () => {
    const refused = { status: "INVALID", reason: "USER_CONFIG_IN_PROJECT" };
    const markers = new Set(["/home/u"]);

    expect(
      load({
        projectRoot: "/home/u/packages/app",
        hasGitMarker: (directory) => markers.has(directory),
      }),
    ).toEqual(refused);
    expect(
      load({
        projectRoot: "/work/project/packages/app",
        hasGitMarker: (directory) => directory === "/work/project",
      }),
    ).toEqual(ENABLED_USER);
  });

  test("the file is read through its canonical path", () => {
    const reads: string[] = [];

    load({
      realPath: (path) => (path === FILE ? "/real/claude-code.yaml" : path),
      readText: (path) => {
        reads.push(path);

        return "text";
      },
    });

    expect(reads).toEqual(["/real/claude-code.yaml"]);
  });

  test("invalid YAML and an unreadable file are typed failures", () => {
    expect(load({ parse: () => ({ status: "INVALID" }) })).toEqual(INVALID);
    expect(
      load({
        readText: () => {
          throw new Error("EIO");
        },
      }),
    ).toEqual({ status: "INVALID", reason: "USER_CONFIG_UNREADABLE" });
  });
});
