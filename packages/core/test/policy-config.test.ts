import { describe, expect, test } from "vitest";
import { diagnosePolicyConfig, type PolicyConfigParser } from "../src/index";

const VALID_CONFIG = [
  "version: 1",
  "thresholds:",
  "  error:",
  "    warn: 0.4",
  "    fail: 0.7",
  "  warning:",
  "    warn: 0.5",
  "    fail: 0.8",
].join("\n");

const VALID_VALUE = {
  version: 1,
  thresholds: { error: { warn: 0.4, fail: 0.7 }, warning: { warn: 0.5, fail: 0.8 } },
};

function parsing(value: unknown): PolicyConfigParser {
  return () => ({ status: "PARSED", value });
}

const unparsable: PolicyConfigParser = () => ({ status: "INVALID", reason: "INVALID_CONFIG" });

describe("diagnosePolicyConfig", () => {
  test("absent text is the defaults", () => {
    const diagnosis = diagnosePolicyConfig(null, unparsable);

    expect(diagnosis.code).toBe("DEFAULTS");
    expect(diagnosis.config.gate.status).not.toBe("INVALID");
  });

  test("unparseable text is PARSE_INVALID and degrades both sections", () => {
    expect(diagnosePolicyConfig("x", unparsable)).toEqual({
      code: "PARSE_INVALID",
      config: {
        gate: { status: "INVALID", reason: "INVALID_CONFIG" },
        remediation: { status: "INVALID", reason: "INVALID_CONFIG" },
      },
    });
  });

  test("a valid config is VALID", () => {
    expect(diagnosePolicyConfig(VALID_CONFIG, parsing(VALID_VALUE)).code).toBe("VALID");
  });

  test("an inverted threshold is GATE_INVALID", () => {
    const value = { version: 1, thresholds: { error: { warn: 0.9, fail: 0.5 } } };

    expect(diagnosePolicyConfig("x", parsing(value)).code).toBe("GATE_INVALID");
  });

  test("an invalid remediation section is REMEDIATION_INVALID", () => {
    const value = { ...VALID_VALUE, remediation: { auto_propose: "nope" } };

    expect(diagnosePolicyConfig("x", parsing(value)).code).toBe("REMEDIATION_INVALID");
  });
});
