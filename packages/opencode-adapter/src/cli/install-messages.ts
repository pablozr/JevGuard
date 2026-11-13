import { JEVGUARD_PLUGIN_ENTRY } from "../opencode-config/entry";
import type { InstallFailureReason, InstallTarget } from "../opencode-config/types";

export const MANUAL_INSTALL_SNIPPET = `{ "plugins": ["${JEVGUARD_PLUGIN_ENTRY}"] }`;

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
        `The plugins list in ${path} is not an array of package entries, so JevGuard did not change it.`,
      );
    case "READ_FAILURE":
      return `Could not read ${path}. Check the file permissions and try again.`;
    case "WRITE_FAILURE":
      return `Could not write ${path}. Check the file permissions and try again.`;
  }
}

function manualSnippetFailure(message: string): string {
  return [message, "Add this to the plugins array manually:", MANUAL_INSTALL_SNIPPET].join("\n");
}
