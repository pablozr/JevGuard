import { describe, expect, it } from "vitest";
import { decideAgentDelivery } from "../src";

const BASE = { agentOptIn: true, fromDelivery: false, deliveredInSession: 0 };

describe("decideAgentDelivery", () => {
  it("delivers below the session limit and stops exactly at it", () => {
    expect(decideAgentDelivery({ ...BASE, deliveredInSession: 2 })).toBe("DELIVER");
    expect(decideAgentDelivery({ ...BASE, deliveredInSession: 3 })).toBe("SESSION_LIMIT");
  });

  it("only shows the panel without the opt-in or for a unit that came from a delivery", () => {
    expect(decideAgentDelivery({ ...BASE, agentOptIn: false })).toBe("PANEL");
    expect(decideAgentDelivery({ ...BASE, fromDelivery: true })).toBe("PANEL");
    expect(decideAgentDelivery({ ...BASE, fromDelivery: true, deliveredInSession: 3 })).toBe(
      "PANEL",
    );
  });
});
