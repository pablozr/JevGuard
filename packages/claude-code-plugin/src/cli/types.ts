import type { HostInstallScope, HostInstallState } from "@jevguard/node-infra";

export type ClaudePluginScope = "user" | "project";

export type ClaudePluginCheckCode = "INSTALLED" | "NOT_INSTALLED" | "INSPECTION_FAILED";

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
