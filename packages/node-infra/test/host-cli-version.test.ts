import { describe, expect, test } from "vitest";
import { parseVersion, satisfiesRange } from "../src";
import { compareVersions } from "../src/host-cli/version";

const RANGE = ">=2.2.2 <2.3";

function satisfies(output: string, range = RANGE): boolean {
  const version = parseVersion(output);

  return version !== null && satisfiesRange(version, range);
}

describe("parseVersion", () => {
  test("reads the first version in a command output", () => {
    expect(parseVersion("opencode 2.2.4 (linux)")).toEqual({
      raw: "2.2.4",
      major: 2,
      minor: 2,
      patch: 4,
      prerelease: false,
    });
  });

  test("keeps the pre-release in the raw text", () => {
    expect(parseVersion("2.2.4-beta.1")).toMatchObject({ raw: "2.2.4-beta.1", prerelease: true });
  });

  test.each([[null], [""], ["no version here"], ["2.2"]])("returns null for %s", (output) => {
    expect(parseVersion(output)).toBeNull();
  });
});

describe("satisfiesRange", () => {
  test.each([
    ["2.2.1", false],
    ["2.2.2", true],
    ["2.2.99", true],
    ["2.3.0", false],
    ["2.1.287", false],
    ["3.0.0", false],
  ])("%s against the exact range edges is %s", (version, expected) => {
    expect(satisfies(version)).toBe(expected);
  });

  test("a pre-release never satisfies a range", () => {
    expect(satisfies("2.2.4-beta.1")).toBe(false);
  });

  test("supports the minimum-only range of Claude Code", () => {
    expect(satisfies("2.1.286", ">=2.1.287")).toBe(false);
    expect(satisfies("2.1.287", ">=2.1.287")).toBe(true);
    expect(satisfies("3.0.0", ">=2.1.287")).toBe(true);
  });

  test("rejects a malformed comparator", () => {
    expect(satisfies("2.2.2", "~2.2")).toBe(false);
  });
});

describe("compareVersions", () => {
  test("orders by major, minor then patch", () => {
    const base = { major: 2, minor: 2, patch: 2 };

    expect(compareVersions({ ...base, major: 3 }, base)).toBeGreaterThan(0);
    expect(compareVersions({ ...base, minor: 1 }, base)).toBeLessThan(0);
    expect(compareVersions(base, base)).toBe(0);
  });
});
