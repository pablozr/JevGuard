import { describe, expect, it } from "vitest";
import {
  AUTO_DELIVERY_MARKER,
  type DeliveryFinding,
  formatAgentDelivery,
  isAutoDeliveredTask,
  NO_STRATEGY_NOTICE,
  REMEDIATION_MAX_TASK_LENGTH,
} from "../src";
import { PROPOSAL_END, PROPOSAL_START } from "../src/remediation/delivery-frame";

const FINDING: DeliveryFinding = {
  id: "no-eval",
  kind: "RULE",
  description: "Do not call eval.",
  severity: "error",
  probability: 0.934,
  violation: "Calls eval.",
  allowed: "Never.",
  locations: [
    { path: "src/a.ts", hunk: { ordinal: 1, newStart: 52, newLines: 4 } },
    { path: "src/b.ts", hunk: null },
  ],
};

const INPUT = { unit: "turn 3", findings: [FINDING], omitted: 0, strategyText: "Replace eval." };

describe("formatAgentDelivery", () => {
  it("opens with the marker prefix so the resulting turn is recognized", () => {
    const text = formatAgentDelivery(INPUT);

    expect(text.startsWith(`${AUTO_DELIVERY_MARKER} · turn 3]`)).toBe(true);
    expect(isAutoDeliveredTask(text)).toBe(true);
    expect(isAutoDeliveredTask(`${AUTO_DELIVERY_MARKER} · attempt 1/2 · chain x]`)).toBe(true);
    expect(isAutoDeliveredTask("fix the bug")).toBe(false);
  });

  it("lists findings with description, locations and the strategy block", () => {
    const text = formatAgentDelivery(INPUT);

    expect(text).toContain("- no-eval — Do not call eval. (error, p=0.93)");
    expect(text).toContain("Violation: Calls eval.");
    expect(text).toContain("Allowed: Never.");
    expect(text).toContain("Location: src/a.ts hunk #1 (+52,4); src/b.ts");
    expect(text).toContain(`${PROPOSAL_START}\nReplace eval.\n${PROPOSAL_END}`);
    expect(text).toContain("do not change tests, configuration, dependencies or .jev/");
    expect(text).toContain("say so and stop");
  });

  it("states that no strategy exists when the proposer failed", () => {
    const text = formatAgentDelivery({ ...INPUT, strategyText: null });

    expect(text).toContain(NO_STRATEGY_NOTICE);
    expect(text).not.toContain(PROPOSAL_START);
    expect(text).toContain("no-eval");
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

  it("clips a long finding text to one line of 1000 characters", () => {
    const text = formatAgentDelivery({
      ...INPUT,
      findings: [{ ...FINDING, violation: `${"x".repeat(1500)}\nsecond line` }],
    });

    const line = text.split("\n").find((entry) => entry.startsWith("  Violation: "));

    expect(line?.length).toBe("  Violation: ".length + 1000);
  });

  it("truncates a huge strategy so the frame fits a task", () => {
    const text = formatAgentDelivery({ ...INPUT, strategyText: "s".repeat(60_000) });

    expect(text.length).toBeLessThanOrEqual(REMEDIATION_MAX_TASK_LENGTH);
    expect(text).toContain(`\n[truncated]\n${PROPOSAL_END}`);
    expect(text).toContain("no-eval");
  });

  it("drops findings that alone exceed the task limit and counts them", () => {
    const finding = { ...FINDING, violation: "v".repeat(1000), allowed: "a".repeat(1000) };
    const text = formatAgentDelivery({
      ...INPUT,
      findings: Array.from({ length: 32 }, () => finding),
      omitted: 1,
    });

    expect(text.length).toBeLessThanOrEqual(REMEDIATION_MAX_TASK_LENGTH);
    expect(text).toMatch(/\+\d+ more findings not listed/);
  });

  it("states how many findings were left out", () => {
    const text = formatAgentDelivery({ ...INPUT, omitted: 1 });

    expect(text).toContain("+1 more findings not listed");
    expect(formatAgentDelivery(INPUT)).not.toContain("more findings not listed");
  });
});
