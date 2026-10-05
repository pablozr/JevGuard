import type { EntryOptions } from "@napi-rs/keyring";
import { describe, expect, test } from "vitest";
import {
  createCredentialProvider,
  CREDENTIAL_ACCOUNT,
  CREDENTIAL_SERVICE,
  login,
} from "../src/index";
import { createKeyringEntry } from "../src/credentials/keyring-store";
import type {
  CredentialEnvironment,
  CredentialStore,
  CredentialStoreDeleteResult,
  CredentialStoreReadResult,
  CredentialStoreWriteResult,
  LoginOutcome,
  SecretPrompt,
  SecretPromptResult,
} from "../src/index";

const ENVIRONMENT_VARIABLE = "TYPESAFE_API_KEY";
const SECRET = "test-key";
const STORED_SECRET = "stored-test-key";

class FakeEnvironment implements CredentialEnvironment {
  private readonly values = new Map<string, string>();

  set(name: string, value: string): void {
    this.values.set(name, value);
  }

  get(name: string): string | undefined {
    return this.values.get(name);
  }
}

class FakeStore implements CredentialStore {
  readResult: CredentialStoreReadResult = { status: "NOT_FOUND" };
  writeResult: CredentialStoreWriteResult = { status: "SAVED" };
  deleteResult: CredentialStoreDeleteResult = { status: "NOT_FOUND" };
  readError: Error | null = null;
  writeError: Error | null = null;
  readCalls = 0;
  readonly writes: string[] = [];

  read(): Promise<CredentialStoreReadResult> {
    this.readCalls += 1;

    if (this.readError !== null) {
      return Promise.reject(this.readError);
    }

    return Promise.resolve(this.readResult);
  }

  write(apiKey: string): Promise<CredentialStoreWriteResult> {
    this.writes.push(apiKey);

    if (this.writeError !== null) {
      return Promise.reject(this.writeError);
    }

    return Promise.resolve(this.writeResult);
  }

  delete(): Promise<CredentialStoreDeleteResult> {
    return Promise.resolve(this.deleteResult);
  }
}

class FakePrompt implements SecretPrompt {
  result: SecretPromptResult = { status: "READ", value: SECRET };
  readError: Error | null = null;
  readonly messages: string[] = [];

  read(message: string): Promise<SecretPromptResult> {
    this.messages.push(message);

    if (this.readError !== null) {
      return Promise.reject(this.readError);
    }

    return Promise.resolve(this.result);
  }
}

function outcomeText(outcome: LoginOutcome): string {
  return JSON.stringify(outcome);
}

describe("credential resolution", () => {
  test("prefers a non-empty environment override over the store", async () => {
    const environment = new FakeEnvironment();
    environment.set(ENVIRONMENT_VARIABLE, "override-test-key");
    const store = new FakeStore();
    store.readResult = { status: "FOUND", apiKey: STORED_SECRET };

    const provider = createCredentialProvider({ environment, store });
    const resolution = await provider.resolve();

    expect(resolution).toEqual({
      status: "AVAILABLE",
      source: "ENVIRONMENT",
      apiKey: "override-test-key",
    });
    expect(store.readCalls).toBe(0);
  });

  test("treats a blank environment override as absent and reads the store", async () => {
    const environment = new FakeEnvironment();
    environment.set(ENVIRONMENT_VARIABLE, "   ");
    const store = new FakeStore();
    store.readResult = { status: "FOUND", apiKey: STORED_SECRET };

    const provider = createCredentialProvider({ environment, store });
    const resolution = await provider.resolve();

    expect(resolution).toEqual({
      status: "AVAILABLE",
      source: "STORE",
      apiKey: STORED_SECRET,
    });
  });

  test("reports a missing credential when neither source provides one", async () => {
    const provider = createCredentialProvider({
      environment: new FakeEnvironment(),
      store: new FakeStore(),
    });

    expect(await provider.resolve()).toEqual({
      status: "UNAVAILABLE",
      reason: "MISSING_CREDENTIAL",
    });
  });

  test("treats a whitespace-only stored secret as a missing credential", async () => {
    const store = new FakeStore();
    store.readResult = { status: "FOUND", apiKey: "   " };

    const provider = createCredentialProvider({
      environment: new FakeEnvironment(),
      store,
    });

    expect(await provider.resolve()).toEqual({
      status: "UNAVAILABLE",
      reason: "MISSING_CREDENTIAL",
    });
  });

  test("normalizes a surrounding-whitespace stored secret", async () => {
    const store = new FakeStore();
    store.readResult = { status: "FOUND", apiKey: `  ${STORED_SECRET}  ` };

    const provider = createCredentialProvider({
      environment: new FakeEnvironment(),
      store,
    });

    expect(await provider.resolve()).toEqual({
      status: "AVAILABLE",
      source: "STORE",
      apiKey: STORED_SECRET,
    });
  });

  test("reports an unavailable resolution when the store read fails", async () => {
    const store = new FakeStore();
    store.readResult = { status: "FAILED", reason: "STORE_READ_FAILURE" };

    const provider = createCredentialProvider({
      environment: new FakeEnvironment(),
      store,
    });

    expect(await provider.resolve()).toEqual({
      status: "UNAVAILABLE",
      reason: "STORE_READ_FAILURE",
    });
  });

  test("maps a rejected store read to an unavailable resolution", async () => {
    const store = new FakeStore();
    store.readError = new Error("backend failure");

    const provider = createCredentialProvider({
      environment: new FakeEnvironment(),
      store,
    });

    expect(await provider.resolve()).toEqual({
      status: "UNAVAILABLE",
      reason: "STORE_READ_FAILURE",
    });
  });
});

describe("login", () => {
  test("saves the prompted secret without returning or exposing it", async () => {
    const prompt = new FakePrompt();
    const store = new FakeStore();

    const outcome = await login({ prompt, store });

    expect(outcome).toEqual({ status: "SAVED" });
    expect(store.writes).toEqual([SECRET]);
    expect(outcomeText(outcome)).not.toContain(SECRET);
  });

  test("normalizes a surrounding-whitespace secret before saving", async () => {
    const prompt = new FakePrompt();
    prompt.result = { status: "READ", value: `  ${SECRET}  ` };
    const store = new FakeStore();

    await login({ prompt, store });

    expect(store.writes).toEqual([SECRET]);
  });

  test("rejects a blank secret without writing", async () => {
    const prompt = new FakePrompt();
    prompt.result = { status: "READ", value: "   " };
    const store = new FakeStore();

    const outcome = await login({ prompt, store });

    expect(outcome).toEqual({ status: "FAILED", reason: "EMPTY_SECRET" });
    expect(store.writes).toEqual([]);
  });

  test("reports an abort without writing", async () => {
    const prompt = new FakePrompt();
    prompt.result = { status: "ABORTED" };
    const store = new FakeStore();

    const outcome = await login({ prompt, store });

    expect(outcome).toEqual({ status: "ABORTED" });
    expect(store.writes).toEqual([]);
  });

  test("maps a non-TTY prompt to a typed failure", async () => {
    const prompt = new FakePrompt();
    prompt.result = { status: "FAILED", reason: "NOT_A_TTY" };
    const store = new FakeStore();

    expect(await login({ prompt, store })).toEqual({
      status: "FAILED",
      reason: "NOT_A_TTY",
    });
    expect(store.writes).toEqual([]);
  });

  test("maps a prompt failure to a typed failure", async () => {
    const prompt = new FakePrompt();
    prompt.result = { status: "FAILED", reason: "PROMPT_FAILURE" };
    const store = new FakeStore();

    expect(await login({ prompt, store })).toEqual({
      status: "FAILED",
      reason: "PROMPT_FAILURE",
    });
  });

  test("maps a store write failure without exposing the secret", async () => {
    const prompt = new FakePrompt();
    const store = new FakeStore();
    store.writeResult = { status: "FAILED", reason: "STORE_WRITE_FAILURE" };

    const outcome = await login({ prompt, store });

    expect(outcome).toEqual({ status: "FAILED", reason: "STORE_WRITE_FAILURE" });
    expect(outcomeText(outcome)).not.toContain(SECRET);
  });

  test("maps a rejected prompt to a typed failure without throwing", async () => {
    const prompt = new FakePrompt();
    prompt.readError = new Error("prompt failure");
    const store = new FakeStore();

    expect(await login({ prompt, store })).toEqual({
      status: "FAILED",
      reason: "PROMPT_FAILURE",
    });
    expect(store.writes).toEqual([]);
  });

  test("maps a rejected store write to a typed failure without exposing the secret", async () => {
    const prompt = new FakePrompt();
    const store = new FakeStore();
    store.writeError = new Error("backend failure");

    const outcome = await login({ prompt, store });

    expect(outcome).toEqual({ status: "FAILED", reason: "STORE_WRITE_FAILURE" });
    expect(outcomeText(outcome)).not.toContain(SECRET);
  });
});

describe("keyring entry options", () => {
  test("pins Linux entries to the persistent Secret Service store", () => {
    const recorded: Array<{ service: string; account: string; options: EntryOptions }> = [];

    class FakeEntry {
      constructor(service: string, account: string, options: EntryOptions) {
        recorded.push({ service, account, options });
      }

      getPassword(): Promise<string | undefined> {
        return Promise.resolve(undefined);
      }

      setPassword(): Promise<void> {
        return Promise.resolve();
      }
      deletePassword(): Promise<boolean> {
        return Promise.resolve(false);
      }
    }

    createKeyringEntry(FakeEntry);

    expect(recorded).toEqual([
      {
        service: CREDENTIAL_SERVICE,
        account: CREDENTIAL_ACCOUNT,
        options: { linux: { store: "secret-service" } },
      },
    ]);
  });
});
