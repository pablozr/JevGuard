import {
  createKeyringCredentialStore,
  createSecretPrompt,
  login,
} from "@jevguard/opencode-adapter";
import type { LoginOutcome } from "@jevguard/opencode-adapter";

export function performLogin(): Promise<LoginOutcome> {
  return login({ prompt: createSecretPrompt(), store: createKeyringCredentialStore() });
}
