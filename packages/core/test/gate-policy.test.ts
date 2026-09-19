import { describe, expect, test } from "vitest";
import { DEFAULT_GATE_CONFIG, evaluateGate, resolveGateConfig } from "../src/index";
import type { GateConfig } from "../src/index";

const customConfig: GateConfig = {
  version: 1,
  thresholds: {
    error: { warn: 0.2, fail: 0.5 },
    warning: { warn: 0.3 },
  },
};

describe("resolveGateConfig", () => {
  test("uses the documented defaults when no config is present", () => {
    expect(DEFAULT_GATE_CONFIG).toEqual({
      version: 1,
      thresholds: { error: { warn: 0.4, fail: 0.7 }, warning: { warn: 0.6 } },
    });

    expect(resolveGateConfig(null)).toEqual({ status: "VALID", config: DEFAULT_GATE_CONFIG });
    expect(resolveGateConfig(undefined)).toEqual({ status: "VALID", config: DEFAULT_GATE_CONFIG });
  });

  test("accepts a complete valid configuration", () => {
    expect(resolveGateConfig(customConfig)).toEqual({
      status: "VALID",
      config: customConfig,
    });
  });

  test.each([
    ["an unsupported version", { version: 2, thresholds: customConfig.thresholds }],
    ["missing thresholds", { version: 1 }],
    ["missing warning thresholds", { version: 1, thresholds: { error: { warn: 0.4, fail: 0.7 } } }],
    [
      "a threshold below zero",
      { version: 1, thresholds: { error: { warn: -0.1, fail: 0.7 }, warning: { warn: 0.6 } } },
    ],
    [
      "a threshold above one",
      { version: 1, thresholds: { error: { warn: 0.4, fail: 1.1 }, warning: { warn: 0.6 } } },
    ],
    [
      "a non-numeric threshold",
      { version: 1, thresholds: { error: { warn: "0.4", fail: 0.7 }, warning: { warn: 0.6 } } },
    ],
    [
      "a non-finite threshold",
      {
        version: 1,
        thresholds: { error: { warn: 0.4, fail: Number.NaN }, warning: { warn: 0.6 } },
      },
    ],
    [
      "warn not below fail",
      { version: 1, thresholds: { error: { warn: 0.7, fail: 0.7 }, warning: { warn: 0.6 } } },
    ],
    ["a non-object config", 1],
    ["an array config", []],
  ])("classifies %s as INVALID_CONFIG", (_label, value) => {
    expect(resolveGateConfig(value)).toEqual({ status: "INVALID", reason: "INVALID_CONFIG" });
  });
});

describe("evaluateGate", () => {
  test("maps error probabilities exactly at both boundaries", () => {
    expect(evaluateGate("error", 0, DEFAULT_GATE_CONFIG)).toEqual({
      outcome: "PASS",
      violationProbability: 0,
    });
    expect(evaluateGate("error", 0.399, DEFAULT_GATE_CONFIG).outcome).toBe("PASS");
    expect(evaluateGate("error", 0.4, DEFAULT_GATE_CONFIG)).toEqual({
      outcome: "WARN",
      violationProbability: 0.4,
    });
    expect(evaluateGate("error", 0.699, DEFAULT_GATE_CONFIG).outcome).toBe("WARN");
    expect(evaluateGate("error", 0.7, DEFAULT_GATE_CONFIG)).toEqual({
      outcome: "FAIL",
      violationProbability: 0.7,
    });
    expect(evaluateGate("error", 1, DEFAULT_GATE_CONFIG).outcome).toBe("FAIL");
  });

  test("maps warning probabilities exactly at the boundary and never fails", () => {
    expect(evaluateGate("warning", 0.599, DEFAULT_GATE_CONFIG).outcome).toBe("PASS");
    expect(evaluateGate("warning", 0.6, DEFAULT_GATE_CONFIG)).toEqual({
      outcome: "WARN",
      violationProbability: 0.6,
    });
    expect(evaluateGate("warning", 0.999, DEFAULT_GATE_CONFIG).outcome).toBe("WARN");
    expect(evaluateGate("warning", 1, DEFAULT_GATE_CONFIG).outcome).toBe("WARN");
  });

  test("honors custom thresholds", () => {
    expect(evaluateGate("error", 0.2, customConfig).outcome).toBe("WARN");
    expect(evaluateGate("error", 0.5, customConfig).outcome).toBe("FAIL");
    expect(evaluateGate("warning", 0.3, customConfig).outcome).toBe("WARN");
  });

  test.each([-0.001, 1.001, Number.NaN, Number.POSITIVE_INFINITY])(
    "never produces a semantic verdict for probability %s",
    (probability) => {
      const expected = { outcome: "UNAVAILABLE", reason: "JEV_FAILURE" };

      expect(evaluateGate("error", probability, DEFAULT_GATE_CONFIG)).toEqual(expected);
      expect(evaluateGate("warning", probability, DEFAULT_GATE_CONFIG)).toEqual(expected);
    },
  );
});
