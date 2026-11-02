import type { DeliveryStatus } from "@jevguard/node-infra";
import { describe, expect, test } from "vitest";
import {
  createOperationalLogSink,
  createRemediationFailureLogSink,
  createRemediationNotifier,
} from "../src/index";
import type { OpenCodeLogRecord, OpenCodeLogWriter, ReviewToast, ToastSink } from "../src/index";

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

class FakeLogWriter implements OpenCodeLogWriter {
  readonly logs: OpenCodeLogRecord[] = [];
  fail = false;

  async write(record: OpenCodeLogRecord): Promise<void> {
    if (this.fail) {
      throw new Error("log unavailable");
    }

    this.logs.push(record);
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
  test("writes one error record whose extra carries only the typed reason", async () => {
    const writer = new FakeLogWriter();

    const status = await createRemediationFailureLogSink(writer).write("CHILD_SESSION_FAILED");

    expect(status).toBe("DELIVERED");
    expect(writer.logs).toEqual([
      {
        service: "jevguard",
        level: "error",
        message: "JevGuard remediation proposal failed",
        extra: { reason: "CHILD_SESSION_FAILED" },
      },
    ]);
    expect(JSON.stringify(writer.logs)).not.toContain(EVIDENCE_SENTINEL);
  });

  test("logs the v2 skip and timeout reasons", async () => {
    const writer = new FakeLogWriter();
    const sink = createRemediationFailureLogSink(writer);

    await sink.write("REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL");
    await sink.write("REMEDIATION_PROPOSAL_TIMEOUT");

    expect(writer.logs.map((log) => log.extra)).toEqual([
      { reason: "REMEDIATION_PROPOSAL_SKIPPED_NO_MODEL" },
      { reason: "REMEDIATION_PROPOSAL_TIMEOUT" },
    ]);
  });

  test("contains a writer failure as FAILED and never throws", async () => {
    const rejected = new FakeLogWriter();

    rejected.fail = true;

    await expect(
      createRemediationFailureLogSink(rejected).write("MODEL_SPECIFIER_INVALID"),
    ).resolves.toBe("FAILED");
  });
});

describe("operational log sink", () => {
  test("logs a skipped execution with its reason only", async () => {
    const writer = new FakeLogWriter();
    const sink = createOperationalLogSink(writer);

    await sink.write({ kind: "TURN_SKIPPED", reason: "interrupted" });
    await sink.write({ kind: "TURN_SKIPPED", reason: "failed" });

    expect(writer.logs).toEqual([
      {
        service: "jevguard",
        level: "info",
        message: "JevGuard skipped · interrupted",
        extra: { reason: "interrupted" },
      },
      {
        service: "jevguard",
        level: "info",
        message: "JevGuard skipped · failed",
        extra: { reason: "failed" },
      },
    ]);
  });

  test("logs an attribution failure with its typed reason", async () => {
    const writer = new FakeLogWriter();

    await createOperationalLogSink(writer).write({
      kind: "ATTRIBUTION_UNAVAILABLE",
      reason: "CONCURRENT_SESSIONS",
    });

    expect(writer.logs).toEqual([
      {
        service: "jevguard",
        level: "warn",
        message: "JevGuard attribution unavailable",
        extra: { reason: "CONCURRENT_SESSIONS" },
      },
    ]);
  });

  test("contains a writer failure as FAILED", async () => {
    const writer = new FakeLogWriter();

    writer.fail = true;

    await expect(
      createOperationalLogSink(writer).write({ kind: "TURN_SKIPPED", reason: "failed" }),
    ).resolves.toBe("FAILED");
  });
});

describe("operational log sink (remediation chain)", () => {
  test("logs each chain step with ids, counts and codes only", async () => {
    const writer = new FakeLogWriter();
    const sink = createOperationalLogSink(writer);

    await sink.write({ kind: "REMEDIATION_SENT", chainId: "msg_a", attempt: 1, maxAttempts: 2 });
    await sink.write({
      kind: "REMEDIATION_STOPPED",
      chainId: "msg_a",
      attempt: 2,
      maxAttempts: 2,
      code: "LIMIT",
    });
    await sink.write({ kind: "REMEDIATION_RESOLVED", chainId: "msg_a", fixed: 1, attempts: 1 });
    await sink.write({ kind: "REMEDIATION_CONFIG_INVALID", reason: "USER_CONFIG_INVALID" });

    expect(writer.logs.map((log) => [log.level, log.message])).toEqual([
      ["info", "JevGuard sent remediation attempt 1/2 to the agent"],
      ["warn", "JevGuard remediation stopped · attempt 2/2 · LIMIT"],
      ["info", "JevGuard remediation resolved · 1 finding(s) fixed in 1 attempt(s)"],
      [
        "warn",
        "JevGuard remediation is off · your opencode.yaml is not valid (USER_CONFIG_INVALID) · see docs/configuration.md",
      ],
    ]);
    expect(writer.logs[1]?.extra).toEqual({
      chainId: "msg_a",
      attempt: 2,
      maxAttempts: 2,
      code: "LIMIT",
    });
  });
});
