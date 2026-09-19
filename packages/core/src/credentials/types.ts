/**
 * Origin of a resolved TypeSafe API key. `ENVIRONMENT` is the CI/automation
 * process override; `STORE` is the native OS credential store.
 */
export type CredentialSource = "ENVIRONMENT" | "STORE";

export type CredentialUnavailableReason = "MISSING_CREDENTIAL" | "STORE_READ_FAILURE";

/**
 * Resolution of the TypeSafe API key. `AVAILABLE` carries the key; `UNAVAILABLE`
 * means no usable credential was obtained, either because no source provided one
 * (`MISSING_CREDENTIAL`) or because a source failed (`STORE_READ_FAILURE`). A
 * failure is never collapsed into `MISSING_CREDENTIAL` or into a semantic verdict.
 */
export type CredentialResolution =
  | { readonly status: "AVAILABLE"; readonly source: CredentialSource; readonly apiKey: string }
  | { readonly status: "UNAVAILABLE"; readonly reason: CredentialUnavailableReason };

/**
 * Read port for the TypeSafe API key. Implementations own environment and OS
 * credential-store access; the core never reads either. Resolutions are typed and
 * never throw.
 */
export interface CredentialProvider {
  resolve(): Promise<CredentialResolution>;
}
