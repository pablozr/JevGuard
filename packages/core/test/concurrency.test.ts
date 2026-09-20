import { describe, expect, test } from "vitest";
import { createFifoJevPort } from "../src/index";
import type {
  JevBuiltInBatchRequest,
  JevEvaluationPort,
  JevEvaluationResult,
  JevRequest,
  JevRuleRequest,
} from "../src/index";
import { evaluateWithPort } from "../src/evaluation/evaluate-with-port";

function request(id: string): JevRuleRequest {
  return {
    kind: "RULE",
    task: "Add a health endpoint.",
    question: {
      type: "noul",
      instructions: "Return the probability that the change violates the rule.",
      criteria: { id, description: "Description.", violation: "Violation." },
    },
    change: { files: ["src/health.ts"], diff: "+ return ok" },
  };
}

function batchRequest(): JevBuiltInBatchRequest {
  const criteria = { id: "CHECK", description: "Description.", violation: "Violation." };

  return {
    kind: "BUILT_IN_BATCH",
    task: "Add a health endpoint.",
    questions: {
      scopeCreep: {
        type: "noul",
        instructions: "Scope creep?",
        criteria: { ...criteria, id: "SCOPE-CREEP" },
      },
      complexity: {
        type: "noul",
        instructions: "Complexity?",
        criteria: { ...criteria, id: "COMPLEXITY" },
      },
    },
    change: { files: ["src/health.ts"], diff: "+ return ok" },
  };
}

function evaluated(probability: number): JevEvaluationResult {
  return { kind: "RULE", status: "EVALUATED", noul: { violationProbability: probability } };
}

class ControlledPort implements JevEvaluationPort {
  readonly started: string[] = [];
  active = 0;
  maxActive = 0;
  private readonly resolvers = new Map<string, (result: JevEvaluationResult) => void>();
  private readonly rejecters = new Map<string, (error: unknown) => void>();
  private readonly completions = new Map<string, () => void>();

  evaluate(input: JevRequest): Promise<JevEvaluationResult> {
    const id = input.kind === "RULE" ? input.question.criteria.id : "BATCH";

    this.started.push(id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    return new Promise<JevEvaluationResult>((resolve, reject) => {
      this.resolvers.set(id, resolve);
      this.rejecters.set(id, reject);
      this.completions.set(id, () => {
        this.active -= 1;
      });
    });
  }

  resolve(id: string, result: JevEvaluationResult): void {
    this.completions.get(id)?.();
    this.resolvers.get(id)?.(result);
  }

  reject(id: string, error: unknown): void {
    this.completions.get(id)?.();
    this.rejecters.get(id)?.(error);
  }
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createFifoJevPort", () => {
  test("limits active evaluations to maxConcurrency and queues the rest", async () => {
    const underlying = new ControlledPort();
    const port = createFifoJevPort(underlying, { maxConcurrency: 2 });

    const first = port.evaluate(request("A"));
    const second = port.evaluate(request("B"));
    const third = port.evaluate(request("C"));

    await tick();

    expect(underlying.started).toEqual(["A", "B"]);
    expect(underlying.maxActive).toBe(2);

    underlying.resolve("A", evaluated(0.1));
    await tick();

    expect(underlying.started).toEqual(["A", "B", "C"]);
    expect(underlying.maxActive).toBe(2);

    underlying.resolve("B", evaluated(0.2));
    underlying.resolve("C", evaluated(0.3));

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      evaluated(0.1),
      evaluated(0.2),
      evaluated(0.3),
    ]);
    expect(underlying.maxActive).toBe(2);
  });

  test("counts the built-in batch as one slot among queued rule calls", async () => {
    const underlying = new ControlledPort();
    const port = createFifoJevPort(underlying, { maxConcurrency: 2 });

    const first = port.evaluate(request("A"));
    const batch = port.evaluate(batchRequest());
    const third = port.evaluate(request("C"));

    await tick();

    expect(underlying.started).toEqual(["A", "BATCH"]);
    expect(underlying.maxActive).toBe(2);

    underlying.resolve("A", evaluated(0.1));
    await tick();

    expect(underlying.started).toEqual(["A", "BATCH", "C"]);
    expect(underlying.maxActive).toBe(2);

    underlying.resolve("BATCH", { kind: "BUILT_IN_BATCH", status: "FAILED", reason: "API_ERROR" });
    underlying.resolve("C", evaluated(0.3));

    await expect(batch).resolves.toEqual({
      kind: "BUILT_IN_BATCH",
      status: "FAILED",
      reason: "API_ERROR",
    });
    await expect(first).resolves.toEqual(evaluated(0.1));
    await expect(third).resolves.toEqual(evaluated(0.3));
  });

  test("starts queued evaluations in FIFO submission order as slots free", async () => {
    const underlying = new ControlledPort();
    const port = createFifoJevPort(underlying, { maxConcurrency: 1 });

    const first = port.evaluate(request("A"));
    const second = port.evaluate(request("B"));
    const third = port.evaluate(request("C"));

    await tick();

    expect(underlying.started).toEqual(["A"]);

    underlying.resolve("A", evaluated(0.1));
    await tick();

    expect(underlying.started).toEqual(["A", "B"]);

    underlying.resolve("B", evaluated(0.1));
    await tick();

    expect(underlying.started).toEqual(["A", "B", "C"]);

    underlying.resolve("C", evaluated(0.1));

    await Promise.all([first, second, third]);
  });

  test("preserves a resolved result unchanged", async () => {
    const underlying = new ControlledPort();
    const port = createFifoJevPort(underlying, { maxConcurrency: 2 });

    const evaluation = port.evaluate(request("A"));

    await tick();
    underlying.resolve("A", evaluated(0.42));

    await expect(evaluation).resolves.toEqual(evaluated(0.42));
  });

  test("preserves an underlying rejection", async () => {
    const underlying = new ControlledPort();
    const port = createFifoJevPort(underlying, { maxConcurrency: 2 });

    const evaluation = port.evaluate(request("A"));

    await tick();
    underlying.reject("A", new Error("transport down"));

    await expect(evaluation).rejects.toThrow("transport down");
  });

  test("lets the higher-level evaluateWithPort contain a wrapper rejection", async () => {
    const underlying = new ControlledPort();
    const port = createFifoJevPort(underlying, { maxConcurrency: 2 });

    const evaluation = evaluateWithPort(port, request("A"));

    await tick();
    underlying.reject("A", new Error("transport down"));

    await expect(evaluation).resolves.toEqual({
      kind: "RULE",
      status: "FAILED",
      reason: "API_ERROR",
    });
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid maxConcurrency of %s",
    (maxConcurrency) => {
      expect(() => createFifoJevPort(new ControlledPort(), { maxConcurrency })).toThrow(RangeError);
    },
  );
});
