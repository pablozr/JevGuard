import {
  createFifoJevPort,
  type JevEvaluationPort,
  type JevEvaluationResult,
  type JevRequest,
} from "@jevguard/core";
import { describe, expect, test } from "vitest";
import type { TypeSafeSystemOneRequest } from "@jevguard/opencode-adapter";
import { CALIBRATION_SEED } from "../fixture-catalog";
import { createObservingClientFactory, createResponseObserver } from "../response-metadata";
import {
  runCalibration,
  selectFixtures,
  type CalibrationRunDependencies,
  type CalibrationRunRequest,
  type CredentialCheck,
} from "../run-calibration";
import type { SyntheticCalibrationFixture } from "../types";

const SENTINEL_KEY = "sk-sentinel-secret-key";
const SENTINEL_TASK = "SENTINEL_TASK_TEXT";
const SENTINEL_DIFF = "SENTINEL_DIFF_TEXT";
const SENTINEL_ERROR = "SENTINEL_RAW_EXCEPTION";

function fixture(index: number): SyntheticCalibrationFixture {
  return {
    schemaVersion: 1,
    id: `fixture-${String(index).padStart(3, "0")}`,
    provenance: "synthetic-author",
    category: "requested-direct",
    difficulty: "clear",
    task: `${SENTINEL_TASK} ${index}`,
    files: [{ path: "src/a.ts", patch: `+const value${index} = 1; ${SENTINEL_DIFF}` }],
    expected: { scopeCreep: "NO_VIOLATION", complexity: "NO_VIOLATION" },
  };
}

function fixtures(count: number): readonly SyntheticCalibrationFixture[] {
  return Array.from({ length: count }, (_unused, index) => fixture(index));
}

class FakePort implements JevEvaluationPort {
  readonly requests: JevRequest[] = [];
  peakActive = 0;
  private active = 0;

  constructor(
    private readonly handler: (
      request: JevRequest,
      index: number,
    ) => Promise<JevEvaluationResult> | JevEvaluationResult,
    private readonly delayMs = 0,
  ) {}

  async evaluate(request: JevRequest): Promise<JevEvaluationResult> {
    this.requests.push(request);
    this.active += 1;
    this.peakActive = Math.max(this.peakActive, this.active);

    try {
      if (this.delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
      }

      return await this.handler(request, this.requests.length - 1);
    } finally {
      this.active -= 1;
    }
  }
}

function batch(scope: number, complexity: number): JevEvaluationResult {
  return {
    kind: "BUILT_IN_BATCH",
    status: "EVALUATED",
    answers: {
      scopeCreep: { status: "EVALUATED", noul: { violationProbability: scope } },
      complexity: { status: "EVALUATED", noul: { violationProbability: complexity } },
    },
  };
}

function batchWithFailedComplexity(scope: number): JevEvaluationResult {
  return {
    kind: "BUILT_IN_BATCH",
    status: "EVALUATED",
    answers: {
      scopeCreep: { status: "EVALUATED", noul: { violationProbability: scope } },
      complexity: { status: "FAILED", reason: "INVALID_RESPONSE" },
    },
  };
}

interface Harness {
  readonly deps: CalibrationRunDependencies;
  readonly logs: string[];
  readonly files: Map<string, string>;
  readonly stats: { createPortCalls: number; lastConcurrency: number };
}

function harness(port: JevEvaluationPort, credential: CredentialCheck = "AVAILABLE"): Harness {
  const logs: string[] = [];
  const files = new Map<string, string>();
  const stats = { createPortCalls: 0, lastConcurrency: 0 };
  const deps: CalibrationRunDependencies = {
    createPort: (concurrency) => {
      stats.createPortCalls += 1;
      stats.lastConcurrency = concurrency;

      return port;
    },
    checkCredential: async () => credential,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    runId: "run-test",
    writeFile: async (path, content) => {
      files.set(path, content);
    },
    log: (line) => {
      logs.push(line);
    },
  };

  return { deps, logs, files, stats };
}

function request(overrides: Partial<CalibrationRunRequest> = {}): CalibrationRunRequest {
  return {
    fixtures: [fixture(0), fixture(1), fixture(2)],
    limit: 3,
    concurrency: 2,
    repeat: 1,
    difficulty: null,
    categories: [],
    confirmLiveApi: "3",
    seed: CALIBRATION_SEED,
    requestedModel: "jev-latest",
    outputDir: "artifacts/calibration/runs/run-test",
    ...overrides,
  };
}

describe("selection", () => {
  test("selects the first N fixtures deterministically", () => {
    const selected = selectFixtures(fixtures(5), null, [], 2);

    expect(selected.map((item) => item.id)).toEqual(["fixture-000", "fixture-001"]);
  });

  test("filters by difficulty and category", () => {
    const sample = fixtures(4);
    const typed = sample.map((item, index) =>
      index === 0
        ? { ...item, difficulty: "borderline" as const, category: "necessary-test" as const }
        : item,
    );

    expect(selectFixtures(typed, "borderline", [], 10)).toHaveLength(1);
    expect(selectFixtures(typed, null, ["necessary-test"], 10)).toHaveLength(1);
  });
});

describe("bulk evaluation", () => {
  test("issues one built-in batch per selected fixture and repeat", async () => {
    const port = new FakePort(() => batch(0.1, 0.1));
    const h = harness(port);
    const result = await runCalibration(request({ repeat: 2, confirmLiveApi: "6" }), h.deps);

    expect(result.status).toBe("COMPLETED");
    expect(port.requests).toHaveLength(6);

    for (const item of port.requests) {
      expect(item.kind).toBe("BUILT_IN_BATCH");

      if (item.kind === "BUILT_IN_BATCH") {
        expect(Object.keys(item.questions).sort()).toEqual(["complexity", "scopeCreep"]);
      }
    }
  });

  test("passes the requested concurrency to the port factory", async () => {
    const port = new FakePort(() => batch(0.1, 0.1));
    const h = harness(port);

    await runCalibration(request({ concurrency: 3 }), h.deps);

    expect(h.stats.lastConcurrency).toBe(3);
  });

  test("respects the FIFO concurrency limit", async () => {
    const port = new FakePort(() => batch(0.1, 0.1), 5);
    const h = harness(port);
    const deps: CalibrationRunDependencies = {
      ...h.deps,
      createPort: (concurrency) => {
        h.stats.createPortCalls += 1;
        h.stats.lastConcurrency = concurrency;

        return createFifoJevPort(port, { maxConcurrency: concurrency });
      },
    };
    const result = await runCalibration(
      request({ fixtures: fixtures(8), limit: 8, repeat: 1, concurrency: 2, confirmLiveApi: "8" }),
      deps,
    );

    expect(result.status).toBe("COMPLETED");
    expect(port.requests).toHaveLength(8);
    expect(port.peakActive).toBeLessThanOrEqual(2);
    expect(port.peakActive).toBeGreaterThanOrEqual(1);
  });
});

describe("confirmation and cost controls", () => {
  test.each([null, "2", "4"])(
    "performs zero calls when --confirm-live-api is %s",
    async (confirm) => {
      const port = new FakePort(() => batch(0.1, 0.1));
      const h = harness(port);
      const result = await runCalibration(request({ confirmLiveApi: confirm }), h.deps);

      expect(result.status).toBe("NOT_CONFIRMED");
      expect(result.exitCode).toBe(0);
      expect(port.requests).toHaveLength(0);
      expect(h.stats.createPortCalls).toBe(0);
      expect(h.logs.join("\n")).toContain("--confirm-live-api 3");
      expect(h.logs.join("\n")).toContain("no live API call");
    },
  );

  test("aborts before any call when planned calls exceed the hard cap", async () => {
    const port = new FakePort(() => batch(0.1, 0.1));
    const h = harness(port);
    const result = await runCalibration(
      request({ fixtures: fixtures(120), limit: 120, repeat: 5, confirmLiveApi: "600" }),
      h.deps,
    );

    expect(result.status).toBe("ABORTED");
    expect(result.exitCode).toBe(1);
    expect(result.plannedLogicalCalls).toBe(600);
    expect(port.requests).toHaveLength(0);
  });
});

describe("credential handling", () => {
  test("emits only a safe login instruction for a missing credential", async () => {
    const port = new FakePort(() => batch(0.1, 0.1));
    const h = harness(port, "MISSING_CREDENTIAL");
    const result = await runCalibration(request(), h.deps);

    expect(result.status).toBe("ABORTED");
    expect(port.requests).toHaveLength(0);
    expect(h.stats.createPortCalls).toBe(0);
    expect(h.logs.join("\n")).toContain("jevguard login");
    expect(h.logs.join("\n")).not.toContain(SENTINEL_KEY);
  });

  test("emits only a safe store instruction for a store read failure", async () => {
    const port = new FakePort(() => batch(0.1, 0.1));
    const h = harness(port, "STORE_READ_FAILURE");
    const result = await runCalibration(request(), h.deps);

    expect(result.status).toBe("ABORTED");
    expect(h.logs.join("\n")).toContain("Retry jevguard login");
  });
});

describe("operational outcomes", () => {
  test("isolates a failed sibling answer", async () => {
    const port = new FakePort(() => batchWithFailedComplexity(0.1));
    const h = harness(port);
    const result = await runCalibration(request(), h.deps);

    expect(result.report).not.toBeNull();
    expect(result.report?.checks.scopeCreep.operational.evaluated).toBe(3);
    expect(result.report?.checks.complexity.operational.unavailable).toBe(3);
    expect(result.exitCode).toBe(1);
  });

  test("returns a nonzero status when evaluations are unavailable", async () => {
    const port = new FakePort(() => {
      throw new Error(`${SENTINEL_KEY} ${SENTINEL_TASK} ${SENTINEL_DIFF} ${SENTINEL_ERROR}`);
    });
    const h = harness(port);
    const result = await runCalibration(request(), h.deps);

    expect(result.status).toBe("COMPLETED");
    expect(result.exitCode).toBe(1);
    expect(result.report?.checks.scopeCreep.operational.unavailable).toBe(3);
  });

  test("returns a zero status when every evaluation succeeds", async () => {
    const port = new FakePort(() => batch(0.2, 0.2));
    const h = harness(port);
    const result = await runCalibration(request(), h.deps);

    expect(result.exitCode).toBe(0);
  });
});

describe("secrecy", () => {
  test("never writes sentinels into reports or logs on success", async () => {
    const port = new FakePort(() => batch(0.1, 0.1));
    const h = harness(port);
    const result = await runCalibration(request(), h.deps);
    const combined = [
      JSON.stringify(result.report),
      [...h.files.values()].join("\n"),
      h.logs.join("\n"),
    ].join("\n");

    expect(combined).not.toContain(SENTINEL_KEY);
    expect(combined).not.toContain(SENTINEL_TASK);
    expect(combined).not.toContain(SENTINEL_DIFF);
  });

  test("never writes sentinels into reports or logs on a raw transport failure", async () => {
    const port = new FakePort(() => {
      throw new Error(`${SENTINEL_KEY} ${SENTINEL_TASK} ${SENTINEL_DIFF} ${SENTINEL_ERROR}`);
    });
    const h = harness(port);
    const result = await runCalibration(request(), h.deps);
    const combined = [
      JSON.stringify(result.report),
      [...h.files.values()].join("\n"),
      h.logs.join("\n"),
    ].join("\n");

    expect(combined).not.toContain(SENTINEL_KEY);
    expect(combined).not.toContain(SENTINEL_TASK);
    expect(combined).not.toContain(SENTINEL_DIFF);
    expect(combined).not.toContain(SENTINEL_ERROR);
  });

  test("writes both report artifacts under the run directory", async () => {
    const port = new FakePort(() => batch(0.1, 0.1));
    const h = harness(port);
    const result = await runCalibration(request(), h.deps);

    expect(result.reportPaths).toEqual({
      json: "artifacts/calibration/runs/run-test/report.json",
      markdown: "artifacts/calibration/runs/run-test/report.md",
    });
    expect(h.files.has("artifacts/calibration/runs/run-test/report.json")).toBe(true);
    expect(h.files.has("artifacts/calibration/runs/run-test/report.md")).toBe(true);
  });
});

function typeSafeRequest(): TypeSafeSystemOneRequest {
  return {
    state: {
      task: "Task",
      checks: {
        scopeCreep: { id: "SCOPE-CREEP", description: "d", violation: "v" },
        complexity: { id: "COMPLEXITY", description: "d", violation: "v" },
      },
      change: { files: ["src/a.ts"], diff: "+x" },
    },
    questions: {
      scopeCreep: { type: "noul", instructions: "i", criteria: { true: "t", false: "f" } },
      complexity: { type: "noul", instructions: "i", criteria: { true: "t", false: "f" } },
    },
    model: "jev-latest",
  };
}

describe("safe response observation", () => {
  test("passes the untouched response through and retains only model and usage", async () => {
    const observer = createResponseObserver();
    const raw = {
      model: "jev-1.13.0",
      usage: { input_tokens: 120, output_tokens: 40 },
      answers: { secret: SENTINEL_KEY },
    };
    const factory = createObservingClientFactory(() => ({ systemOne: async () => raw }), observer);
    const response = await factory("api-key").systemOne(typeSafeRequest());
    const snapshot = observer.snapshot();

    expect(response).toBe(raw);
    expect(snapshot.returnedModels).toEqual({ "jev-1.13.0": 1 });
    expect(snapshot.inputTokens).toBe(120);
    expect(snapshot.outputTokens).toBe(40);
    expect(snapshot.responsesWithUsage).toBe(1);
    expect(JSON.stringify(snapshot)).not.toContain(SENTINEL_KEY);
  });

  test("ignores a malformed envelope without throwing or retaining it", () => {
    const observer = createResponseObserver();

    observer.observe(null);
    observer.observe("not-an-object");
    observer.observe({ usage: { input_tokens: -1 } });

    const snapshot = observer.snapshot();

    expect(snapshot.returnedModels).toEqual({});
    expect(snapshot.inputTokens).toBe(0);
    expect(snapshot.outputTokens).toBe(0);
  });
});
