import { describe, expect, test } from "vitest";
import { createRemediationNotifier } from "../src/index";
import type { DeliveryStatus, ReviewToast, ToastSink } from "../src/index";

class FakeToast implements ToastSink {
  readonly toasts: ReviewToast[] = [];
  fail = false;

  async show(toast: ReviewToast): Promise<DeliveryStatus> {
    if (this.fail) {
      throw new Error("toast unavailable");
    }

    this.toasts.push(toast);

    return "DELIVERED";
  }
}

describe("remediation notifier", () => {
  test("emits generic preparing and ready toasts naming no evidence", async () => {
    const toast = new FakeToast();
    const notifier = createRemediationNotifier(toast);

    await notifier.proposalPreparing();
    await notifier.proposalReady();

    expect(toast.toasts).toEqual([
      {
        title: "JevGuard",
        message: "JevGuard is preparing a remediation proposal in the child session.",
        variant: "info",
      },
      {
        title: "JevGuard",
        message: "JevGuard remediation proposal ready.",
        variant: "info",
      },
    ]);
  });

  test("contains a toast failure as FAILED and never throws", async () => {
    const toast = new FakeToast();

    toast.fail = true;

    const notifier = createRemediationNotifier(toast);

    await expect(notifier.proposalPreparing()).resolves.toBe("FAILED");
    await expect(notifier.proposalReady()).resolves.toBe("FAILED");
  });
});
