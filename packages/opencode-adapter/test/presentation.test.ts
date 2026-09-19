import type { ReviewResult, SkippedReason, UnavailableReason } from "@jevguard/core";
import { describe, expect, test } from "vitest";
import {
  createOpenCodeLogSink,
  createOpenCodeToastSink,
  createReviewPresenter,
  logLevelFor,
  toReviewLogEntry,
  toReviewToast,
} from "../src/index";
import type {
  DeliveryStatus,
  OpenCodeLogInput,
  OpenCodeLogResult,
  OpenCodePresentationClient,
  OpenCodeToastInput,
  OpenCodeToastResult,
  ReviewLogEntry,
  StructuredLogSink,
  ToastSink,
} from "../src/index";

function semantic(outcome: "PASS" | "WARN" | "FAIL", probability: number): ReviewResult {
  return {
    turnId: "turn-1",
    ruleId: "ARCH-001",
    severity: "error",
    scopedPaths: ["src/a.ts", "src/b.ts"],
    outcome,
    violationProbability: probability,
  };
}

function skipped(reason: SkippedReason): ReviewResult {
  return {
    turnId: "turn-1",
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "SKIPPED",
    reason,
  };
}

function unavailable(reason: UnavailableReason): ReviewResult {
  return {
    turnId: "turn-1",
    ruleId: null,
    severity: null,
    scopedPaths: [],
    outcome: "UNAVAILABLE",
    reason,
  };
}

class FakeLogSink implements StructuredLogSink {
  result: DeliveryStatus = "DELIVERED";
  error: Error | null = null;
  readonly entries: ReviewLogEntry[] = [];

  async write(entry: ReviewLogEntry): Promise<DeliveryStatus> {
    this.entries.push(entry);

    if (this.error !== null) {
      throw this.error;
    }

    return this.result;
  }
}

class FakeToastSink implements ToastSink {
  result: DeliveryStatus = "DELIVERED";
  error: Error | null = null;
  readonly toasts: ReturnType<typeof toReviewToast>[] = [];

  async show(toast: ReturnType<typeof toReviewToast>): Promise<DeliveryStatus> {
    this.toasts.push(toast);

    if (this.error !== null) {
      throw this.error;
    }

    return this.result;
  }
}

class FakeOpenCodeClient implements OpenCodePresentationClient {
  logResult: OpenCodeLogResult = {};
  toastResult: OpenCodeToastResult = {};
  logError: Error | null = null;
  toastError: Error | null = null;
  readonly logCalls: OpenCodeLogInput[] = [];
  readonly toastCalls: OpenCodeToastInput[] = [];

  readonly app = {
    log: (input: OpenCodeLogInput): Promise<OpenCodeLogResult> => {
      this.logCalls.push(input);

      if (this.logError !== null) {
        return Promise.reject(this.logError);
      }

      return Promise.resolve(this.logResult);
    },
  };

  readonly tui = {
    showToast: (input: OpenCodeToastInput): Promise<OpenCodeToastResult> => {
      this.toastCalls.push(input);

      if (this.toastError !== null) {
        return Promise.reject(this.toastError);
      }

      return Promise.resolve(this.toastResult);
    },
  };
}

describe("structured log mapping", () => {
  test.each<[ReviewResult["outcome"], "info" | "warn" | "error"]>([
    ["PASS", "info"],
    ["SKIPPED", "info"],
    ["WARN", "warn"],
    ["FAIL", "error"],
    ["UNAVAILABLE", "error"],
  ])("maps %s to the %s level", (outcome, level) => {
    expect(logLevelFor(outcome)).toBe(level);
  });

  test("keeps exactly the allowlisted semantic fields", () => {
    const entry = toReviewLogEntry(semantic("PASS", 0.12));

    expect(entry).toEqual({
      turnId: "turn-1",
      ruleId: "ARCH-001",
      severity: "error",
      scopedPaths: ["src/a.ts", "src/b.ts"],
      outcome: "PASS",
      violationProbability: 0.12,
    });
  });

  test("keeps exactly the allowlisted operational fields", () => {
    const entry = toReviewLogEntry(unavailable("JEV_FAILURE"));

    expect(entry).toEqual({
      turnId: "turn-1",
      ruleId: null,
      severity: null,
      scopedPaths: [],
      outcome: "UNAVAILABLE",
      reason: "JEV_FAILURE",
    });
  });
});

describe("toast mapping", () => {
  test.each<[ReviewResult, "success" | "warning" | "error" | "info"]>([
    [semantic("PASS", 0.1), "success"],
    [semantic("WARN", 0.5), "warning"],
    [semantic("FAIL", 0.9), "error"],
    [skipped("NO_SCOPE_MATCH"), "info"],
    [unavailable("BLOCKED_EVIDENCE"), "error"],
  ])("maps %# to the expected variant", (result, variant) => {
    expect(toReviewToast(result).variant).toBe(variant);
  });

  test("includes the rule and probability for a semantic outcome", () => {
    expect(toReviewToast(semantic("WARN", 0.5))).toEqual({
      title: "JevGuard WARN",
      message: "ARCH-001 · probability 0.50",
      variant: "warning",
    });
  });

  test("includes the rule fallback and reason for an operational outcome", () => {
    expect(toReviewToast(skipped("NO_ATTRIBUTED_PATCH"))).toEqual({
      title: "JevGuard SKIPPED",
      message: "unknown · NO_ATTRIBUTED_PATCH",
      variant: "info",
    });
  });
});

describe("review presenter", () => {
  test("delivers to both sinks and reports delivered", async () => {
    const log = new FakeLogSink();
    const toast = new FakeToastSink();

    const delivery = await createReviewPresenter({ log, toast }).present(semantic("FAIL", 0.9));

    expect(delivery).toEqual({ log: "DELIVERED", toast: "DELIVERED" });
    expect(log.entries).toHaveLength(1);
    expect(toast.toasts).toHaveLength(1);
  });

  test("isolates a log failure from the toast delivery", async () => {
    const log = new FakeLogSink();
    log.error = new Error("log backend down");
    const toast = new FakeToastSink();

    const delivery = await createReviewPresenter({ log, toast }).present(semantic("PASS", 0.1));

    expect(delivery).toEqual({ log: "FAILED", toast: "DELIVERED" });
    expect(toast.toasts).toHaveLength(1);
  });

  test("isolates a toast failure from the log delivery", async () => {
    const log = new FakeLogSink();
    const toast = new FakeToastSink();
    toast.error = new Error("toast backend down");

    const delivery = await createReviewPresenter({ log, toast }).present(semantic("PASS", 0.1));

    expect(delivery).toEqual({ log: "DELIVERED", toast: "FAILED" });
    expect(log.entries).toHaveLength(1);
  });

  test("propagates a typed sink failure without throwing", async () => {
    const log = new FakeLogSink();
    log.result = "FAILED";
    const toast = new FakeToastSink();
    toast.result = "FAILED";

    await expect(
      createReviewPresenter({ log, toast }).present(semantic("WARN", 0.5)),
    ).resolves.toEqual({ log: "FAILED", toast: "FAILED" });
  });
});

describe("OpenCode sinks", () => {
  test("sends a safe log payload with the allowlisted extra fields", async () => {
    const client = new FakeOpenCodeClient();
    const sink = createOpenCodeLogSink(client);

    const status = await sink.write(toReviewLogEntry(semantic("FAIL", 0.9)));

    expect(status).toBe("DELIVERED");
    expect(client.logCalls).toHaveLength(1);
    expect(client.logCalls[0]?.body).toEqual({
      service: "jevguard",
      level: "error",
      message: "JevGuard FAIL for ARCH-001 (probability 0.9)",
      extra: {
        turnId: "turn-1",
        ruleId: "ARCH-001",
        severity: "error",
        scopedPaths: ["src/a.ts", "src/b.ts"],
        outcome: "FAIL",
        violationProbability: 0.9,
      },
    });
  });

  test("maps a log result error to FAILED", async () => {
    const client = new FakeOpenCodeClient();
    client.logResult = { error: { message: "bad request" } };

    expect(await createOpenCodeLogSink(client).write(toReviewLogEntry(semantic("PASS", 0.1)))).toBe(
      "FAILED",
    );
  });

  test("maps a rejected log request to FAILED", async () => {
    const client = new FakeOpenCodeClient();
    client.logError = new Error("connection reset");

    expect(await createOpenCodeLogSink(client).write(toReviewLogEntry(semantic("PASS", 0.1)))).toBe(
      "FAILED",
    );
  });

  test("sends a transient toast and never a session message", async () => {
    const client = new FakeOpenCodeClient();
    const sink = createOpenCodeToastSink(client);

    const status = await sink.show(toReviewToast(semantic("WARN", 0.5)));

    expect(status).toBe("DELIVERED");
    expect(client.toastCalls).toHaveLength(1);
    expect(client.toastCalls[0]?.body).toEqual({
      title: "JevGuard WARN",
      message: "ARCH-001 · probability 0.50",
      variant: "warning",
      duration: 5000,
    });
    expect("session" in client).toBe(false);
  });

  test("maps a toast result error to FAILED", async () => {
    const client = new FakeOpenCodeClient();
    client.toastResult = { error: { message: "tui unavailable" } };

    expect(await createOpenCodeToastSink(client).show(toReviewToast(semantic("PASS", 0.1)))).toBe(
      "FAILED",
    );
  });

  test("maps a rejected toast request to FAILED", async () => {
    const client = new FakeOpenCodeClient();
    client.toastError = new Error("connection reset");

    expect(await createOpenCodeToastSink(client).show(toReviewToast(semantic("PASS", 0.1)))).toBe(
      "FAILED",
    );
  });
});
