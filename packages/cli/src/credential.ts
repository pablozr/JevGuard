import type { CredentialProvider, CredentialResolution } from "@jevguard/core";

/** Resolves the credential; a provider that throws becomes `STORE_READ_FAILURE`. */
export async function resolveCredentialSafely(
  provider: CredentialProvider,
): Promise<CredentialResolution> {
  try {
    return await provider.resolve();
  } catch {
    return { status: "UNAVAILABLE", reason: "STORE_READ_FAILURE" };
  }
}
