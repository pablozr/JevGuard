import { normalizeSecret } from "./secret";
import type {
  CredentialStore,
  CredentialStoreWriteResult,
  LoginFailureReason,
  LoginInput,
  LoginOutcome,
  SecretPrompt,
  SecretPromptResult,
} from "./types";

type CollectedSecret =
  | { readonly status: "READ"; readonly value: string }
  | { readonly status: "ABORTED" }
  | { readonly status: "FAILED"; readonly reason: LoginFailureReason };

/**
 * Collects the API key with a masked prompt and saves it to the credential store.
 * The secret never appears in an outcome, every failure maps to a typed reason, and
 * a rejected prompt or store never throws out of the login flow.
 */
export async function login(input: LoginInput): Promise<LoginOutcome> {
  const prompted = await readPrompt(input.prompt);
  const collected = collectSecret(prompted);

  if (collected.status !== "READ") {
    return collected;
  }

  const written = await writeSecret(input.store, collected.value);

  if (written.status === "FAILED") {
    return { status: "FAILED", reason: "STORE_WRITE_FAILURE" };
  }

  return { status: "SAVED" };
}

async function readPrompt(prompt: SecretPrompt): Promise<SecretPromptResult> {
  try {
    return await prompt.read("TypeSafe API key: ");
  } catch {
    return { status: "FAILED", reason: "PROMPT_FAILURE" };
  }
}

async function writeSecret(
  store: CredentialStore,
  value: string,
): Promise<CredentialStoreWriteResult> {
  try {
    return await store.write(value);
  } catch {
    return { status: "FAILED", reason: "STORE_WRITE_FAILURE" };
  }
}

function collectSecret(prompted: SecretPromptResult): CollectedSecret {
  if (prompted.status === "ABORTED") {
    return { status: "ABORTED" };
  }

  if (prompted.status === "FAILED") {
    return { status: "FAILED", reason: prompted.reason };
  }

  const secret = normalizeSecret(prompted.value);

  if (secret === null) {
    return { status: "FAILED", reason: "EMPTY_SECRET" };
  }

  return { status: "READ", value: secret };
}
