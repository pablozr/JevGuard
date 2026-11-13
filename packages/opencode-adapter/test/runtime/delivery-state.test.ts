import { MAX_AGENT_DELIVERIES_PER_SESSION } from "@jevguard/core";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDeliveryLedger } from "../../src/runtime/remediation/deliveries";
import { createSessionIdleWaiter } from "../../src/runtime/remediation/idle-waiter";

describe("delivery ledger", () => {
  test("reserves up to the session limit and refuses the next one", () => {
    const ledger = createDeliveryLedger();

    for (let index = 0; index < MAX_AGENT_DELIVERIES_PER_SESSION; index += 1) {
      expect(ledger.reserve("a")).toBe(true);
    }

    expect(ledger.reserve("a")).toBe(false);
    expect(ledger.used("a")).toBe(MAX_AGENT_DELIVERIES_PER_SESSION);
    expect(ledger.reserve("b")).toBe(true);
  });

  test("a released reservation gives the allowance back and a committed one keeps it", () => {
    const ledger = createDeliveryLedger();

    ledger.reserve("a");
    ledger.release("a");

    expect(ledger.used("a")).toBe(0);

    ledger.reserve("a");
    ledger.commit("a");
    ledger.release("a");

    expect(ledger.used("a")).toBe(1);
  });

  test("forgets the least recently used session past the cap", () => {
    const ledger = createDeliveryLedger(2);

    ledger.reserve("a");
    ledger.reserve("b");
    ledger.reserve("c");

    expect(ledger.used("a")).toBe(0);
    expect(ledger.used("b")).toBe(1);
    expect(ledger.used("c")).toBe(1);
  });
});

describe("session idle waiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves at once for an idle session", async () => {
    const waiter = createSessionIdleWaiter(() => false);

    await expect(waiter.untilIdle("a", 1_000)).resolves.toBe("IDLE");
  });

  test("resolves IDLE when the session goes idle", async () => {
    let busy = true;
    const waiter = createSessionIdleWaiter(() => busy);
    const waiting = waiter.untilIdle("a", 1_000);

    waiter.notifyIdle("a");
    busy = false;
    waiter.notifyIdle("a");

    await expect(waiting).resolves.toBe("IDLE");
  });

  test("resolves TIMEOUT when the session stays busy", async () => {
    vi.useFakeTimers();

    const waiter = createSessionIdleWaiter(() => true);
    const waiting = waiter.untilIdle("a", 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(waiting).resolves.toBe("TIMEOUT");
  });
});
