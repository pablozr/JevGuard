import type { HostInstallScope, HostInstallState } from "@jevguard/node-infra";

export type ClaudePluginScope = "user" | "project";

export type ClaudePluginCheckCode =
  | "INSTALLED"
  | "DISABLED"
  | "NOT_INSTALLED"
  | "INSPECTION_FAILED";

export interface ClaudeConfigDir {
  readonly dir: string;
  readonly source: "CLAUDE_CONFIG_DIR" | "DEFAULT";
}

export type ClaudeInstallFailureCode =
  | "CLAUDE_NOT_FOUND"
  | "VERSION_UNSUPPORTED"
  | "NOT_A_TTY"
  | "MARKETPLACE_FAILED"
  | "INSTALL_FAILED";

export interface ScopeInspection {
  readonly scope: HostInstallScope;
  readonly state: HostInstallState;
}
