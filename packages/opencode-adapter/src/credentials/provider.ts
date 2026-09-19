import type { CredentialProvider, CredentialResolution } from "@jevguard/core";
import { API_KEY_ENVIRONMENT_VARIABLE } from "./constants";
import { normalizeSecret } from "./secret";
import type {
  CredentialProviderDependencies,
  CredentialStore,
  CredentialStoreReadResult,
} from "./types";

/**
 * Resolves the API key with the documented precedence: a non-empty process
 * environment override for CI/automation, then the OS credential store. An absent
 * or blank credential is `UNAVAILABLE` with `MISSING_CREDENTIAL`; a store read
 * failure or rejection is `UNAVAILABLE` with `STORE_READ_FAILURE`. Never throws.
 */
export function createCredentialProvider(
  dependencies: CredentialProviderDependencies,
): CredentialProvider {
  return {
    async resolve(): Promise<CredentialResolution> {
      const override = normalizeSecret(dependencies.environment.get(API_KEY_ENVIRONMENT_VARIABLE));

      if (override !== null) {
        return { status: "AVAILABLE", source: "ENVIRONMENT", apiKey: override };
      }

      const stored = await readStored(dependencies.store);

      switch (stored.status) {
        case "FOUND": {
          const secret = normalizeSecret(stored.apiKey);

          if (secret === null) {
            return { status: "UNAVAILABLE", reason: "MISSING_CREDENTIAL" };
          }

          return { status: "AVAILABLE", source: "STORE", apiKey: secret };
        }
        case "NOT_FOUND":
          return { status: "UNAVAILABLE", reason: "MISSING_CREDENTIAL" };
        case "FAILED":
          return { status: "UNAVAILABLE", reason: stored.reason };
      }
    },
  };
}

async function readStored(store: CredentialStore): Promise<CredentialStoreReadResult> {
  try {
    return await store.read();
  } catch {
    return { status: "FAILED", reason: "STORE_READ_FAILURE" };
  }
}
