import type {
  CredentialProvider,
  CredentialResolution,
  JevEvaluationResult,
  JevRequest,
} from "@jevguard/core";
import { describe, expect, test } from "vitest";
import { buildTypeSafeClientConfig, createJevTransport } from "../src/index";
import type { TypeSafeSystemOneClient, TypeSafeSystemOneRequest } from "../src/index";

const API_KEY = "resolved-test-key";
const TASK = "Add a health endpoint";
const DIFF = "+ return ok";

class FakeCredentialProvider implements CredentialProvider {
  resolution: CredentialResolution = { status: "AVAILABLE", source: "STORE", apiKey: API_KEY };
  reject: Error | null = null;
  calls = 0;

  async resolve(): Promise<CredentialResolution> {
    this.calls += 1;

    if (this.reject !== null) {
      throw this.reject;
    }

    return this.resolution;
  }
}

class FakeSystemOneClient implements TypeSafeSystemOneClient {
  response: unknown = { answers: { violation: { type: "noul", noul: 0.5 } } };
  reject: Error | null = null;
  readonly requests: TypeSafeSystemOneRequest[] = [];

  async systemOne(request: TypeSafeSystemOneRequest): Promise<unknown> {
    this.requests.push(request);

    if (this.reject !== null) {
      throw this.reject;
    }

    return this.response;
  }
}

interface Harness {
  readonly provider: FakeCredentialProvider;
  readonly client: FakeSystemOneClient;
  readonly keys: string[];
  readonly port: ReturnType<typeof createJevTransport>;
}

function harness(): Harness {
  const provider = new FakeCredentialProvider();
  const client = new FakeSystemOneClient();
  const keys: string[] = [];
  const port = createJevTransport({
    credentials: provider,
    createClient: (apiKey) => {
      keys.push(apiKey);
      return client;
    },
  });

  return { provider, client, keys, port };
}

function request(overrides: Partial<JevRequest> = {}): JevRequest {
  return {
    task: TASK,
    question: {
      type: "noul",
      instructions: "Answer true when the change violates the rule.",
      criteria: {
        id: "ARCH-001",
        description: "Controllers stay thin.",
        violation: "The controller performs domain logic.",
      },
    },
    change: { files: ["src/health.ts"], diff: DIFF },
    ...overrides,
  };
}

function semanticResponse(noul: number): unknown {
  return { answers: { violation: { type: "noul", noul } } };
}

describe("TypeSafe client configuration", () => {
  test("pins an explicit key, jev-latest, and logging off", () => {
    expect(buildTypeSafeClientConfig(API_KEY)).toEqual({
      apiKey: API_KEY,
      defaultModel: "jev-latest",
      logLevel: "off",
    });
  });
});

describe("Jev transport credential handling", () => {
  test("resolves the credential on every evaluate and passes the key to the client factory", async () => {
    const h = harness();

    await h.port.evaluate(request());
    await h.port.evaluate(request());

    expect(h.provider.calls).toBe(2);
    expect(h.keys).toEqual([API_KEY, API_KEY]);
  });

  test("maps a missing credential to MISSING_CREDENTIAL", async () => {
    const h = harness();
    h.provider.resolution = { status: "UNAVAILABLE", reason: "MISSING_CREDENTIAL" };

    expect(await h.port.evaluate(request())).toEqual({
      status: "FAILED",
      reason: "MISSING_CREDENTIAL",
    });
    expect(h.client.requests).toEqual([]);
  });

  test("maps a credential store failure to API_ERROR", async () => {
    const h = harness();
    h.provider.resolution = { status: "UNAVAILABLE", reason: "STORE_READ_FAILURE" };

    expect(await h.port.evaluate(request())).toEqual({ status: "FAILED", reason: "API_ERROR" });
  });

  test("maps a rejected credential resolution to API_ERROR", async () => {
    const h = harness();
    h.provider.reject = new Error("credential backend down");

    expect(await h.port.evaluate(request())).toEqual({ status: "FAILED", reason: "API_ERROR" });
  });

  test("maps a throwing client factory to API_ERROR without leaking the key or message", async () => {
    const provider = new FakeCredentialProvider();
    const port = createJevTransport({
      credentials: provider,
      createClient: () => {
        throw new Error(`factory failed for ${API_KEY} while reviewing ${TASK} ${DIFF}`);
      },
    });

    const result = await port.evaluate(request());
    const serialized = JSON.stringify(result);

    expect(result).toEqual({ status: "FAILED", reason: "API_ERROR" });
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(TASK);
    expect(serialized).not.toContain(DIFF);
    expect(serialized).not.toContain("factory failed");
  });
});

describe("Jev transport request payload", () => {
  test("sends one Noul with task, rule, change, and jev-latest", async () => {
    const h = harness();

    await h.port.evaluate(request());

    expect(h.client.requests).toHaveLength(1);
    expect(h.client.requests[0]).toEqual({
      state: {
        task: TASK,
        rule: {
          id: "ARCH-001",
          description: "Controllers stay thin.",
          violation: "The controller performs domain logic.",
        },
        change: { files: ["src/health.ts"], diff: DIFF },
      },
      questions: {
        violation: {
          type: "noul",
          instructions: "Answer true when the change violates the rule.",
          criteria: {
            true: "The controller performs domain logic.",
            false: "The change does not violate the rule's Violation.",
          },
        },
      },
      model: "jev-latest",
    });
  });

  test("carries the Allowed exception as the false criterion when present", async () => {
    const h = harness();
    const withAllowed = request({
      question: {
        type: "noul",
        instructions: "Answer true when the change violates the rule.",
        criteria: {
          id: "ARCH-001",
          description: "Controllers stay thin.",
          violation: "The controller performs domain logic.",
          allowed: "Validation and HTTP mapping.",
        },
      },
    });

    await h.port.evaluate(withAllowed);

    const sent = h.client.requests[0];
    expect(sent?.state.rule).toEqual({
      id: "ARCH-001",
      description: "Controllers stay thin.",
      violation: "The controller performs domain logic.",
      allowed: "Validation and HTTP mapping.",
    });
    expect(sent?.questions.violation.criteria.false).toBe("Validation and HTTP mapping.");
  });
});

describe("Jev transport response validation", () => {
  test.each<[string, number]>([
    ["lower bound", 0],
    ["midpoint", 0.5],
    ["upper bound", 1],
  ])("accepts a finite noul in range at the %s", async (_label, noul) => {
    const h = harness();
    h.client.response = semanticResponse(noul);

    expect(await h.port.evaluate(request())).toEqual({
      status: "EVALUATED",
      noul: { violationProbability: noul },
    });
  });

  test.each<[string, unknown]>([
    ["null response", null],
    ["text response", "not-json"],
    ["empty object", {}],
    ["missing answers", { model: "jev-latest" }],
    ["answers not an object", { answers: [] }],
    ["missing violation", { answers: {} }],
    ["wrong answer type", { answers: { violation: { type: "choice", noul: 0.5 } } }],
    ["non-numeric noul", { answers: { violation: { type: "noul", noul: "0.5" } } }],
    ["NaN noul", { answers: { violation: { type: "noul", noul: Number.NaN } } }],
    ["infinite noul", { answers: { violation: { type: "noul", noul: Number.POSITIVE_INFINITY } } }],
    ["negative noul", { answers: { violation: { type: "noul", noul: -0.1 } } }],
    ["noul above one", { answers: { violation: { type: "noul", noul: 1.1 } } }],
  ])("rejects %s as INVALID_RESPONSE", async (_label, response) => {
    const h = harness();
    h.client.response = response;

    expect(await h.port.evaluate(request())).toEqual({
      status: "FAILED",
      reason: "INVALID_RESPONSE",
    });
  });

  test("maps a rejected request to API_ERROR", async () => {
    const h = harness();
    h.client.reject = new Error("network failure");

    expect(await h.port.evaluate(request())).toEqual({ status: "FAILED", reason: "API_ERROR" });
  });
});

describe("Jev transport secrecy", () => {
  test("never returns the key, task, diff, or external error", async () => {
    const h = harness();
    h.client.reject = new Error(`failed with ${API_KEY} while reviewing ${TASK} ${DIFF}`);

    const result: JevEvaluationResult = await h.port.evaluate(request());
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(TASK);
    expect(serialized).not.toContain(DIFF);
    expect(serialized).not.toContain("failed with");
  });
});
