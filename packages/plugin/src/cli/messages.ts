import { JEVGUARD_PLUGIN_ENTRY } from "@jevguard/opencode-adapter";
import type {
  InstallFailureReason,
  InstallTarget,
  LoginFailureReason,
} from "@jevguard/opencode-adapter";

export const USAGE = [
  "Usage: jevguard login",
  "       jevguard install [--project]",
  "",
  "`jev-init` and `jevguard-rules` are OpenCode skills, not CLI commands. Register",
  "the plugin in opencode.json (or run `jevguard install`) and invoke them from",
  "OpenCode.",
].join("\n");

export const LOGIN_SAVED_MESSAGE = "Credential saved to the OS credential store.";

export const LOGIN_ABORTED_MESSAGE = "Login cancelled. No credential was saved.";

export const MANUAL_INSTALL_SNIPPET = `{ "plugin": ["${JEVGUARD_PLUGIN_ENTRY}"] }`;

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

export function describeInstallInstalled(target: InstallTarget, path: string): string {
  return `Registered JevGuard for the ${target} target in ${path}. Restart OpenCode to load it.`;
}

export function describeInstallAlreadyInstalled(target: InstallTarget, path: string): string {
  return `JevGuard is already registered for the ${target} target in ${path}.`;
}

export function describeInstallAborted(path: string): string {
  return `Install cancelled. ${path} was not changed.`;
}

export function describeInstallFailure(reason: InstallFailureReason, path: string): string {
  switch (reason) {
    case "NOT_A_TTY":
      return manualSnippetFailure(`${path} cannot be confirmed without an interactive terminal.`);
    case "UNSUPPORTED_JSONC":
      return manualSnippetFailure(
        `${path} is absent, but a sibling opencode.jsonc exists. JevGuard never edits .jsonc files.`,
      );
    case "INVALID_JSON":
      return manualSnippetFailure(`Could not parse ${path} as JSON.`);
    case "INVALID_CONFIG_SHAPE":
      return manualSnippetFailure(
        `The plugin entry in ${path} is not an array of strings, so JevGuard did not change it.`,
      );
    case "READ_FAILURE":
      return `Could not read ${path}. Check the file permissions and try again.`;
    case "WRITE_FAILURE":
      return `Could not write ${path}. Check the file permissions and try again.`;
  }
}

function manualSnippetFailure(message: string): string {
  return [message, "Add this to the plugin array manually:", MANUAL_INSTALL_SNIPPET].join("\n");
}
