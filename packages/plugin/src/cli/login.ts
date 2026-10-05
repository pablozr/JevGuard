import { createKeyringCredentialStore, createSecretPrompt, login } from "@jevguard/node-infra";
import type { LoginOutcome } from "@jevguard/node-infra";

export function performLogin(): Promise<LoginOutcome> {
  return login({ prompt: createSecretPrompt(), store: createKeyringCredentialStore() });
}
