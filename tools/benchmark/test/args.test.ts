import { describe, expect, it } from "vitest";
import { DEFAULT_HOST_CASES, LIST_PRICE, parseArguments } from "../args";

describe("parseArguments", () => {
  it("needs no options for the default run", () => {
    const parsed = parseArguments(["run"]);

    expect(parsed.status).toBe("OK");
    if (parsed.status !== "OK") return;

    expect(parsed.command.hosts).toEqual(["opencode", "claude-code"]);
    expect(parsed.command.hostCases).toBe(DEFAULT_HOST_CASES);
    expect(parsed.command.confirmLiveRuns).toBeNull();
    expect(parsed.command.pricing).toEqual(LIST_PRICE);
  });

  it("accepts none as the host selection", () => {
    const parsed = parseArguments(["run", "--hosts", "none"]);

    expect(parsed.status).toBe("OK");
    if (parsed.status !== "OK") return;
    expect(parsed.command.hosts).toEqual([]);
  });

  it("rejects an unknown host", () => {
    const parsed = parseArguments(["run", "--hosts", "vscode"]);

    expect(parsed.status).toBe("ERROR");
  });

  it("rejects a repeat outside the accepted range", () => {
    expect(parseArguments(["run", "--repeat", "9"]).status).toBe("ERROR");
    expect(parseArguments(["run", "--repeat", "0"]).status).toBe("ERROR");
  });

  it("rejects a negative price", () => {
    expect(parseArguments(["run", "--price-input", "-1"]).status).toBe("ERROR");
  });

  it("keeps rule filters in order", () => {
    const parsed = parseArguments(["run", "--rule", "SECRETS-001", "--rule", "SCOPE-001"]);

    expect(parsed.status).toBe("OK");
    if (parsed.status !== "OK") return;
    expect(parsed.command.ruleIds).toEqual(["SECRETS-001", "SCOPE-001"]);
  });
});
