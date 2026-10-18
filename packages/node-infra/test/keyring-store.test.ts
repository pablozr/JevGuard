import { beforeEach, describe, expect, test, vi } from "vitest";
import { createKeyringCredentialStore } from "../src/credentials/keyring-store";

const keyring = vi.hoisted(() => ({ stored: null as string | null | undefined }));

vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    getPassword(): Promise<string | null | undefined> {
      return Promise.resolve(keyring.stored);
    }
  },
}));

describe("keyring credential store read", () => {
  beforeEach(() => {
    keyring.stored = null;
  });

  test("treats the null the native addon returns for a missing entry as not found", async () => {
    keyring.stored = null;

    await expect(createKeyringCredentialStore().read()).resolves.toEqual({ status: "NOT_FOUND" });
  });

  test("treats undefined and empty values as not found", async () => {
    keyring.stored = undefined;
    await expect(createKeyringCredentialStore().read()).resolves.toEqual({ status: "NOT_FOUND" });

    keyring.stored = "";
    await expect(createKeyringCredentialStore().read()).resolves.toEqual({ status: "NOT_FOUND" });
  });

  test("returns a stored key", async () => {
    keyring.stored = "stored-key";

    await expect(createKeyringCredentialStore().read()).resolves.toEqual({
      status: "FOUND",
      apiKey: "stored-key",
    });
  });
});
