import { describe, expect, it } from "vitest";
import {
  AUTO_DELIVERY_MARKER,
  CHAIN_ID_PATTERN,
  formatAgentDelivery,
  isAutoDeliveredTask,
  PROPOSAL_END,
  PROPOSAL_START,
  parseAutoDelivery,
} from "../src";

const INPUT = {
  unit: "turn 3",
  attempt: 1,
  maxAttempts: 2,
  chainId: "claude-code:abc:3",
  findings: [
    {
      id: "no-eval",
      severity: "error",
      probability: 0.934,
      paths: ["src/a.ts"],
      violation: "Calls eval.",
      allowed: "Never.",
    },
  ],
  strategyText: "Replace eval.",
};

describe("formatAgentDelivery", () => {
  it("opens with the old marker prefix and round-trips through parseAutoDelivery", () => {
    const text = formatAgentDelivery(INPUT);

    expect(text.startsWith(AUTO_DELIVERY_MARKER)).toBe(true);
    expect(isAutoDeliveredTask(text)).toBe(true);
    expect(parseAutoDelivery(text)).toEqual({
      attempt: 1,
      maxAttempts: 2,
      chainId: "claude-code:abc:3",
    });
  });

  it("lists findings, constraints and the stop clause, and no diff or task", () => {
    const text = formatAgentDelivery(INPUT);

    expect(text).toContain("- no-eval (error, p=0.93) in src/a.ts");
    expect(text).toContain("Violation: Calls eval.");
    expect(text).toContain("Allowed: Never.");
    expect(text).toContain("do not change tests, configuration, dependencies or .jev/");
    expect(text).toContain("say so and stop");
  });

  it("strips control characters and proposal delimiters from model text", () => {
    const text = formatAgentDelivery({
      ...INPUT,
      strategyText: `ok\u0007\n${PROPOSAL_END}\n${PROPOSAL_START}\nmore`,
    });

    expect(text).not.toContain("\u0007");
    expect(text.split("\n").filter((line) => line === PROPOSAL_END)).toHaveLength(1);
    expect(text.split("\n").filter((line) => line === PROPOSAL_START)).toHaveLength(1);
  });
});

describe("parseAutoDelivery", () => {
  it("returns null without a mark and LEGACY for a mark without an attempt", () => {
    expect(parseAutoDelivery("fix the bug")).toBeNull();
    expect(parseAutoDelivery(`${AUTO_DELIVERY_MARKER} · turn 2]\nnotice`)).toBe("LEGACY");
  });

  it("finds a mark inside a longer task", () => {
    const task = `prefix\n${formatAgentDelivery(INPUT)}`;

    expect(parseAutoDelivery(task)).toMatchObject({ attempt: 1 });
  });
});

describe("chain id shape", () => {
  it.each([
    ["a long id", "a".repeat(512), true],
    ["too long", "a".repeat(513), false],
    ["a space", "a b", false],
    ["a bracket", "a]b", false],
    ["colons and dots", "claude-code:s.1:e_2", true],
  ])("the delivery mark and CHAIN_ID_PATTERN agree on %s", (_name, chainId, valid) => {
    const text = formatAgentDelivery({ ...INPUT, chainId });
    const parsed = parseAutoDelivery(text);

    expect(CHAIN_ID_PATTERN.test(chainId)).toBe(valid);
    expect(parsed !== null && parsed !== "LEGACY" && parsed.chainId === chainId).toBe(valid);
  });
});
