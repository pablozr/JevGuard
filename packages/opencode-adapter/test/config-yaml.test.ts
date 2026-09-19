import { describe, expect, test } from "vitest";
import { parsePolicyConfig } from "../src/index";

describe("policy config YAML parsing", () => {
  test("parses a valid single-document config into a plain unknown", () => {
    const result = parsePolicyConfig(
      "version: 1\nthresholds:\n  error:\n    warn: 0.4\n    fail: 0.7\n  warning:\n    warn: 0.6\n",
    );

    expect(result).toEqual({
      status: "PARSED",
      value: {
        version: 1,
        thresholds: {
          error: { warn: 0.4, fail: 0.7 },
          warning: { warn: 0.6 },
        },
      },
    });
  });

  test.each<[string, string]>([
    ["a syntax error", "version: [1"],
    ["a duplicate key", "version: 1\nversion: 1"],
    ["multiple documents", "version: 1\n---\nversion: 1"],
    ["an empty document", ""],
    ["a whitespace-only document", "   \n  "],
    ["a comments-only document", "# just a comment"],
    ["an anchor and alias", "a: &x 1\nb: *x"],
    ["a known tag", "version: !!str 1"],
    ["a custom tag", "version: !custom 1"],
  ])("rejects %s", (_label, text) => {
    expect(parsePolicyConfig(text)).toEqual({ status: "INVALID", reason: "INVALID_CONFIG" });
  });

  test("does not validate the core config shape", () => {
    expect(parsePolicyConfig("anything: [1, 2, 3]")).toEqual({
      status: "PARSED",
      value: { anything: [1, 2, 3] },
    });
  });
});
