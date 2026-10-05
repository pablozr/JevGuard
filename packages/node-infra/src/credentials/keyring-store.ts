import type { EntryOptions } from "@napi-rs/keyring";
import { CREDENTIAL_ACCOUNT, CREDENTIAL_SERVICE } from "./constants";
import type {
  CredentialStore,
  CredentialStoreDeleteResult,
  CredentialStoreReadResult,
  CredentialStoreWriteResult,
} from "./types";

interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}

interface KeyringEntryConstructor {
  new (service: string, account: string, options: EntryOptions): KeyringEntry;
}

/**
 * Linux credential stores are pinned to the persistent Secret Service backend:
 * the platform default can silently fall back to the in-memory kernel keyring,
 * which drops the credential when the process exits.
 */
const KEYRING_ENTRY_OPTIONS: EntryOptions = { linux: { store: "secret-service" } };

/**
 * Builds a keyring entry with JevGuard's service, account, and platform options.
 * Exported only so a focused test can assert the options without touching a real
 * credential; it is not part of the package's public surface.
 */
export function createKeyringEntry(EntryConstructor: KeyringEntryConstructor): KeyringEntry {
  return new EntryConstructor(CREDENTIAL_SERVICE, CREDENTIAL_ACCOUNT, KEYRING_ENTRY_OPTIONS);
}

/**
 * Native OS credential-store implementation. The N-API addon is loaded lazily so
 * importing the adapter never initializes a platform credential backend.
 */
export function createKeyringCredentialStore(): CredentialStore {
  return {
    read: readCredential,
    write: writeCredential,
    delete: deleteCredential,
  };
}

async function readCredential(): Promise<CredentialStoreReadResult> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const value = await createKeyringEntry(AsyncEntry).getPassword();

    if (value === undefined || value.length === 0) {
      return { status: "NOT_FOUND" };
    }

    return { status: "FOUND", apiKey: value };
  } catch {
    return { status: "FAILED", reason: "STORE_READ_FAILURE" };
  }
}

async function writeCredential(apiKey: string): Promise<CredentialStoreWriteResult> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    await createKeyringEntry(AsyncEntry).setPassword(apiKey);

    return { status: "SAVED" };
  } catch {
    return { status: "FAILED", reason: "STORE_WRITE_FAILURE" };
  }
}

async function deleteCredential(): Promise<CredentialStoreDeleteResult> {
  try {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    const deleted = await createKeyringEntry(AsyncEntry).deletePassword();

    return deleted ? { status: "DELETED" } : { status: "NOT_FOUND" };
  } catch {
    return { status: "FAILED", reason: "STORE_DELETE_FAILURE" };
  }
}
