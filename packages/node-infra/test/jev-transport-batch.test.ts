import type {
  CredentialProvider,
  CredentialResolution,
  JevRuleEvaluationResult,
  JevRuleRequest,
} from "@jevguard/core";
import { describe, expect, test } from "vitest";
import { createJevTransport, RULE_BATCH_CONCURRENCY } from "../src/index";
import type { TypeSafeSystemOneClient, TypeSafeSystemOneRequest } from "../src/index";

const API_KEY = "resolved-test-key";
const TASK = "Add a health endpoint";
const DIFF = "+ return ok";

class FakeCredentialProvider implements CredentialProvider {
  resolution: CredentialResolution = { status: "AVAILABLE", source: "STORE", apiKey: API_KEY };
  calls = 0;

  async resolve(): Promise<CredentialResolution> {
    this.calls += 1;

    return this.resolution;
  }
}

interface ClientOptions {
  readonly delayFor?: (id: string) => number;
  readonly valueFor?: (id: string) => number;
  readonly failFor?: (id: string) => boolean;
}

class FakeSystemOneClient implements TypeSafeSystemOneClient {
  active = 0;
  maxActive = 0;
  readonly ids: string[] = [];

  constructor(private readonly options: ClientOptions = {}) {}

  async systemOne(request: TypeSafeSystemOneRequest): Promise<unknown> {
    const id = ruleId(request);

    this.ids.push(id);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);

    try {
      const delay = this.options.delayFor?.(id) ?? 0;

      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      if (this.options.failFor?.(id) === true) {
        throw new Error(`failed with ${API_KEY} while reviewing ${TASK} ${DIFF}`);
      }

      return { answers: { violation: { type: "noul", noul: this.options.valueFor?.(id) ?? 0.5 } } };
    } finally {
      this.active -= 1;
    }
  }
}

function ruleId(request: TypeSafeSystemOneRequest): string {
  return "rule" in request.state ? request.state.rule.id : "";
}

function request(id: string): JevRuleRequest {
  return {
    kind: "RULE",
    task: TASK,
    question: {
      type: "noul",
      instructions: "Answer true when the change violates the rule.",
      criteria: { id, description: "Controllers stay thin.", violation: "Domain logic." },
    },
    change: { files: ["src/health.ts"], diff: DIFF },
  };
}

function evaluated(probability: number): JevRuleEvaluationResult {
  return { kind: "RULE", status: "EVALUATED", noul: { violationProbability: probability } };
}

interface Harness {
  readonly provider: FakeCredentialProvider;
  readonly keys: string[];
  readonly port: ReturnType<typeof createJevTransport>;
}

function harness(client: FakeSystemOneClient): Harness {
  const provider = new FakeCredentialProvider();
  const keys: string[] = [];
  const port = createJevTransport({
    credentials: provider,
    createClient: (apiKey) => {
      keys.push(apiKey);
      return client;
    },
  });

  return { provider, keys, port };
}

describe("Jev transport rule batch", () => {
  test("resolves the credential once and creates one client for the whole batch", async () => {
    const client = new FakeSystemOneClient({ valueFor: () => 0.1 });
    const { provider, keys, port } = harness(client);

    const results = await port.evaluateRuleBatch([request("A"), request("B"), request("C")]);

    expect(provider.calls).toBe(1);
    expect(keys).toEqual([API_KEY]);
    expect(results).toEqual([evaluated(0.1), evaluated(0.1), evaluated(0.1)]);
  });

  test("never exceeds the adapter concurrency cap", async () => {
    const client = new FakeSystemOneClient({ delayFor: () => 10, valueFor: () => 0.1 });
    const { port } = harness(client);
    const requests = Array.from({ length: 8 }, (_unused, index) => request(`R-${index}`));

    await port.evaluateRuleBatch(requests);

    expect(client.maxActive).toBeLessThanOrEqual(RULE_BATCH_CONCURRENCY);
    expect(client.maxActive).toBe(RULE_BATCH_CONCURRENCY);
  });

  test("returns results in input order even when a later request resolves first", async () => {
    const delays = new Map([
      ["A", 30],
      ["B", 15],
      ["C", 0],
    ]);
    const values = new Map([
      ["A", 0.1],
      ["B", 0.2],
      ["C", 0.3],
    ]);
    const client = new FakeSystemOneClient({
      delayFor: (id) => delays.get(id) ?? 0,
      valueFor: (id) => values.get(id) ?? 0,
    });
    const { port } = harness(client);

    const results = await port.evaluateRuleBatch([request("A"), request("B"), request("C")]);

    expect(results).toEqual([evaluated(0.1), evaluated(0.2), evaluated(0.3)]);
    expect(client.ids).toEqual(["A", "B", "C"]);
  });

  test("contains one failed request without discarding its siblings", async () => {
    const client = new FakeSystemOneClient({ valueFor: () => 0.1, failFor: (id) => id === "B" });
    const { port } = harness(client);

    const results = await port.evaluateRuleBatch([request("A"), request("B"), request("C")]);

    expect(results).toEqual([
      evaluated(0.1),
      { kind: "RULE", status: "FAILED", reason: "API_ERROR" },
      evaluated(0.1),
    ]);
  });

  test("maps a missing credential to a typed failure for every request without a client", async () => {
    const client = new FakeSystemOneClient();
    const { provider, keys, port } = harness(client);
    provider.resolution = { status: "UNAVAILABLE", reason: "MISSING_CREDENTIAL" };

    const results = await port.evaluateRuleBatch([request("A"), request("B")]);

    expect(results).toEqual([
      { kind: "RULE", status: "FAILED", reason: "MISSING_CREDENTIAL" },
      { kind: "RULE", status: "FAILED", reason: "MISSING_CREDENTIAL" },
    ]);
    expect(keys).toHaveLength(0);
  });

  test("never returns the key, task, diff, or external error for a batch", async () => {
    const client = new FakeSystemOneClient({ failFor: () => true });
    const { port } = harness(client);

    const results = await port.evaluateRuleBatch([request("A"), request("B")]);
    const serialized = JSON.stringify(results);

    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(TASK);
    expect(serialized).not.toContain(DIFF);
    expect(serialized).not.toContain("failed with");
  });
});
