import { CLAUDE_SUPPORTED_RANGE, MARKETPLACE_SOURCE, PLUGIN_ID } from "./constants";
import type { ClaudeInstallFailureCode, ClaudePluginScope } from "./types";

export function manualInstallCommands(scope: ClaudePluginScope): readonly string[] {
  return [
    `claude plugin marketplace add ${MARKETPLACE_SOURCE} --scope ${scope}`,
    `claude plugin install ${PLUGIN_ID} --scope ${scope}`,
  ];
}

export function describeInstallInstalled(scope: ClaudePluginScope, configDir: string): string {
  return `Installed JevGuard for Claude Code (${scope} scope, config dir ${configDir}). Start a new Claude Code session to load it.`;
}

export function describeInstallAlreadyInstalled(
  scope: ClaudePluginScope,
  configDir: string,
): string {
  return `JevGuard is already installed for Claude Code (${scope} scope, config dir ${configDir}).`;
}

export function describeInstallAborted(): string {
  return "Install cancelled. Claude Code was not changed.";
}

export function describeInstallFailure(
  code: ClaudeInstallFailureCode,
  scope: ClaudePluginScope,
): readonly string[] {
  return [failureHeadline(code), "Run these commands manually:", ...manualInstallCommands(scope)];
}

function failureHeadline(code: ClaudeInstallFailureCode): string {
  switch (code) {
    case "CLAUDE_NOT_FOUND":
      return "The `claude` command was not found on PATH.";
    case "VERSION_UNSUPPORTED":
      return `JevGuard needs Claude Code ${CLAUDE_SUPPORTED_RANGE}.`;
    case "NOT_A_TTY":
      return "The install cannot be confirmed without an interactive terminal.";
    case "MARKETPLACE_FAILED":
      return "Claude Code could not add the JevGuard marketplace.";
    case "INSTALL_FAILED":
      return "Claude Code could not install the JevGuard plugin.";
  }
}
