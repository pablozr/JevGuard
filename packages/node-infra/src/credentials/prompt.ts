import type { SecretPrompt, SecretPromptResult } from "./types";

/**
 * Masked terminal prompt backed by a maintained prompt library. The library owns
 * echo suppression and terminal restoration on success, error, and interruption.
 */
export function createSecretPrompt(): SecretPrompt {
  return {
    read: readSecret,
  };
}

async function readSecret(message: string): Promise<SecretPromptResult> {
  if (process.stdin.isTTY !== true) {
    return { status: "FAILED", reason: "NOT_A_TTY" };
  }

  try {
    const { default: password } = await import("@inquirer/password");
    const value = await password({ message, mask: true });

    return { status: "READ", value };
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") {
      return { status: "ABORTED" };
    }

    return { status: "FAILED", reason: "PROMPT_FAILURE" };
  }
}
