import { describe, expect, test } from "vitest";
import { createRemediationFailureLogSink, createRemediationNotifier } from "../src/index";
import type {
  DeliveryStatus,
  OpenCodeLogInput,
  OpenCodeLogResult,
  OpenCodePresentationClient,
  OpenCodeSessionSelectInput,
  OpenCodeSessionSelectResult,
  OpenCodeToastInput,
  OpenCodeToastResult,
  ReviewToast,
  ToastSink,
} from "../src/index";

const EVIDENCE_SENTINEL = "EVIDENCE_SENTINEL_4f2a";

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

class FakeLogClient implements OpenCodePresentationClient {
  readonly logs: OpenCodeLogInput[] = [];
  fail = false;
  resultError = false;

  readonly app = {
    log: async (input: OpenCodeLogInput): Promise<OpenCodeLogResult> => {
      if (this.fail) {
        throw new Error("log unavailable");
      }

      this.logs.push(input);

      return this.resultError ? { error: { message: "bad" } } : {};
    },
  };

  readonly tui = {
    showToast: async (_input: OpenCodeToastInput): Promise<OpenCodeToastResult> => ({}),
    selectSession: async (
      _input: OpenCodeSessionSelectInput,
    ): Promise<OpenCodeSessionSelectResult> => ({}),
  };
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

  test("emits a fixed generic failure toast with the error variant", async () => {
    const toast = new FakeToast();

    await createRemediationNotifier(toast).proposalFailed();

    expect(toast.toasts).toEqual([
      {
        title: "JevGuard",
        message: "JevGuard could not prepare a remediation proposal.",
        variant: "error",
      },
    ]);
  });

  test("contains a toast failure as FAILED and never throws", async () => {
    const toast = new FakeToast();

    toast.fail = true;

    const notifier = createRemediationNotifier(toast);

    await expect(notifier.proposalPreparing()).resolves.toBe("FAILED");
    await expect(notifier.proposalReady()).resolves.toBe("FAILED");
    await expect(notifier.proposalFailed()).resolves.toBe("FAILED");
  });
});

describe("remediation failure log sink", () => {
  test("writes one error entry whose extra carries only the typed reason", async () => {
    const client = new FakeLogClient();

    const status = await createRemediationFailureLogSink(client).write("CHILD_SESSION_FAILED");

    expect(status).toBe("DELIVERED");
    expect(client.logs).toEqual([
      {
        body: {
          service: "jevguard",
          level: "error",
          message: "JevGuard remediation proposal failed",
          extra: { reason: "CHILD_SESSION_FAILED" },
        },
      },
    ]);
    expect(JSON.stringify(client.logs)).not.toContain(EVIDENCE_SENTINEL);
  });

  test("contains an error result and a rejection as FAILED and never throws", async () => {
    const errorResult = new FakeLogClient();

    errorResult.resultError = true;

    await expect(
      createRemediationFailureLogSink(errorResult).write("PROPOSAL_PROMPT_FAILED"),
    ).resolves.toBe("FAILED");

    const rejected = new FakeLogClient();

    rejected.fail = true;

    await expect(
      createRemediationFailureLogSink(rejected).write("MODEL_SPECIFIER_INVALID"),
    ).resolves.toBe("FAILED");
  });
});
