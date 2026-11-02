import { MAX_AGENT_DELIVERIES_PER_SESSION } from "@jevguard/core";
import { describe, expect, it } from "vitest";
import { createRemediationChains } from "../src/remediation/chains";

describe("createRemediationChains delivery counts", () => {
  it("limits each session and keeps only a bounded number of sessions", () => {
    const chains = createRemediationChains(64, 2);

    for (let count = 0; count < MAX_AGENT_DELIVERIES_PER_SESSION; count += 1) {
      expect(chains.countDelivery("a")).toBe(true);
    }

    expect(chains.countDelivery("a")).toBe(false);

    chains.countDelivery("b");
    chains.countDelivery("c");

    // "a" was the least recently counted of three sessions, so its limit started over.
    expect(chains.countDelivery("a")).toBe(true);
  });
});
