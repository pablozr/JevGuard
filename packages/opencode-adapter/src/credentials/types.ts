export interface CredentialEnvironment {
  get(name: string): string | undefined;
}

export interface CredentialProviderDependencies {
  readonly environment: CredentialEnvironment;
  readonly store: CredentialStore;
}

export type CredentialStoreReadResult =
  | { readonly status: "FOUND"; readonly apiKey: string }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "FAILED"; readonly reason: "STORE_READ_FAILURE" };

export type CredentialStoreWriteResult =
  | { readonly status: "SAVED" }
  | { readonly status: "FAILED"; readonly reason: "STORE_WRITE_FAILURE" };

export type CredentialStoreDeleteResult =
  | { readonly status: "DELETED" }
  | { readonly status: "NOT_FOUND" }
  | { readonly status: "FAILED"; readonly reason: "STORE_DELETE_FAILURE" };

/**
 * Read/write port over a native OS credential store. Implementations must never
 * log or serialize the secret, and failures are typed rather than thrown.
 */
export interface CredentialStore {
  read(): Promise<CredentialStoreReadResult>;
  write(apiKey: string): Promise<CredentialStoreWriteResult>;
  delete(): Promise<CredentialStoreDeleteResult>;
}

export type SecretPromptFailureReason = "NOT_A_TTY" | "PROMPT_FAILURE";

export type SecretPromptResult =
  | { readonly status: "READ"; readonly value: string }
  | { readonly status: "ABORTED" }
  | { readonly status: "FAILED"; readonly reason: SecretPromptFailureReason };

/**
 * Masked terminal prompt port. Implementations must never echo the entered secret
 * and must restore the terminal on success, error, and interruption.
 */
export interface SecretPrompt {
  read(message: string): Promise<SecretPromptResult>;
}

export type LoginFailureReason =
  | "NOT_A_TTY"
  | "EMPTY_SECRET"
  | "PROMPT_FAILURE"
  | "STORE_WRITE_FAILURE";

/**
 * Outcome of `jevguard login`. It never carries the secret; failures stay typed
 * so the CLI can render a safe message without serializing a native error.
 */
export type LoginOutcome =
  | { readonly status: "SAVED" }
  | { readonly status: "ABORTED" }
  | { readonly status: "FAILED"; readonly reason: LoginFailureReason };

export interface LoginInput {
  readonly prompt: SecretPrompt;
  readonly store: CredentialStore;
}
