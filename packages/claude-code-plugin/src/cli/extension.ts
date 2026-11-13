import type { HostCliExtension } from "@jevguard/node-infra";
import {
  CLAUDE_CONFIG_FILE_NAME,
  CLAUDE_SETTINGS_RULES,
} from "@jevguard/claude-code-adapter/presentation";
import { detectClaudeCode } from "./detect";
import { claudeDoctorChecks } from "./doctor-checks";
import { installClaudePlugin } from "./install";
import { inspectPlugin } from "./inspect";

/** The Claude Code side of the host-neutral CLI: plugin install through `claude plugin`. */
export function createClaudeCodeCliExtension(): HostCliExtension {
  return {
    id: "claude-code",
    displayName: "Claude Code",
    userConfigFileName: CLAUDE_CONFIG_FILE_NAME,
    remediationRules: CLAUDE_SETTINGS_RULES,
    detect: detectClaudeCode,
    inspectInstall: inspectPlugin,
    install: installClaudePlugin,
    doctor: claudeDoctorChecks,
  };
}
