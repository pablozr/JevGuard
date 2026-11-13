import {
  type HostCheckStatus,
  type HostCliContext,
  type HostDoctorCheck,
  type HostInstallScope,
  versionDoctorCheck,
} from "@jevguard/node-infra";
import { CLAUDE_COMMAND } from "./constants";
import { detectClaudeCode } from "./detect";
import { describeClaudePlugin } from "./doctor-messages";
import { inspectScope, readPluginEntries } from "./inspect";
import type { ClaudePluginCheckCode, ScopeInspection } from "./types";

const SCOPES: readonly HostInstallScope[] = ["global", "project"];

export async function claudeDoctorChecks(
  context: HostCliContext,
): Promise<readonly HostDoctorCheck[]> {
  const [entries, detection] = await Promise.all([
    readPluginEntries(context),
    detectClaudeCode(context),
  ]);
  const scopes = SCOPES.map(
    (scope): ScopeInspection => ({ scope, state: inspectScope(entries, scope).state }),
  );

  return [
    pluginCheck(scopes),
    versionDoctorCheck(detection, {
      id: "claude-version",
      displayName: "Claude Code",
      command: CLAUDE_COMMAND,
    }),
  ];
}

function pluginCode(scopes: readonly ScopeInspection[]): ClaudePluginCheckCode {
  if (scopes.some((entry) => entry.state === "UNKNOWN")) return "INSPECTION_FAILED";

  return scopes.some((entry) => entry.state === "INSTALLED") ? "INSTALLED" : "NOT_INSTALLED";
}

function pluginCheck(scopes: readonly ScopeInspection[]): HostDoctorCheck {
  const code = pluginCode(scopes);
  const status: HostCheckStatus = code === "INSTALLED" ? "OK" : "WARN";
  const described = describeClaudePlugin(code, scopes);

  return {
    json: { id: "claude-plugin", status, code, scopes },
    message: described.message,
    annotation: described.annotation,
  };
}
