import type { LoginFailureReason } from "@jevguard/opencode-adapter";

export const USAGE = "Usage: jevguard login";

export const LOGIN_SAVED_MESSAGE = "Credential saved to the OS credential store.";

export const LOGIN_ABORTED_MESSAGE = "Login cancelled. No credential was saved.";

export function describeLoginFailure(reason: LoginFailureReason): string {
  switch (reason) {
    case "NOT_A_TTY":
      return "Login requires an interactive terminal. Run `jevguard login` in a terminal.";
    case "EMPTY_SECRET":
      return "No credential was saved. Enter a non-empty API key.";
    case "PROMPT_FAILURE":
      return "Could not read the credential from the terminal. Try again.";
    case "STORE_WRITE_FAILURE":
      return "Could not save the credential to the OS credential store. Check that a credential store is available and try again.";
  }
}
