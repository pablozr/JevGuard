import {
  detectHostVersion,
  type HostCheckStatus,
  type HostCliContext,
  type HostDoctorCheck,
  type HostInstallScope,
  versionDoctorCheck,
} from "@jevguard/node-infra";
import { claudeConfigDirOf } from "./config-dir";
import {
  CLAUDE_COMMAND,
  CLAUDE_VERSION_TIMEOUT_MS,
  NODE_COMMAND,
  NODE_SUPPORTED_RANGE,
} from "./constants";
import { detectClaudeCode } from "./detect";
import { describeClaudeConfigDir, describeClaudePlugin } from "./doctor-messages";
import { inspectScope, isScopeEnabled, readPluginEntries } from "./inspect";
import type { ClaudeConfigDir, ClaudePluginCheckCode, ScopeInspection } from "./types";

const SCOPES: readonly HostInstallScope[] = ["global", "project"];

export async function claudeDoctorChecks(
  context: HostCliContext,
): Promise<readonly HostDoctorCheck[]> {
  const configDir = claudeConfigDirOf(context);
  const [entries, detection, node] = await Promise.all([
    readPluginEntries(context),
    detectClaudeCode(context),
    detectHostVersion(context.processes, {
      host: "claude-code",
      command: NODE_COMMAND,
      range: NODE_SUPPORTED_RANGE,
      timeoutMs: CLAUDE_VERSION_TIMEOUT_MS,
    }),
  ]);
  const scopes = SCOPES.map(
    (scope): ScopeInspection => ({ scope, state: inspectScope(entries, scope).state }),
  );
  const enabled = SCOPES.some((scope) => isScopeEnabled(entries, scope));

  return [
    pluginCheck(scopes, enabled, configDir),
    versionDoctorCheck(detection, {
      id: "claude-version",
      displayName: "Claude Code",
      command: CLAUDE_COMMAND,
    }),
    configDirCheck(configDir),
    versionDoctorCheck(node, {
      id: "claude-node",
      displayName: "Node",
      command: NODE_COMMAND,
    }),
  ];
}

function pluginCode(scopes: readonly ScopeInspection[], enabled: boolean): ClaudePluginCheckCode {
  if (scopes.some((entry) => entry.state === "UNKNOWN")) return "INSPECTION_FAILED";

  if (!scopes.some((entry) => entry.state === "INSTALLED")) return "NOT_INSTALLED";

  return enabled ? "INSTALLED" : "DISABLED";
}

function pluginCheck(
  scopes: readonly ScopeInspection[],
  enabled: boolean,
  configDir: ClaudeConfigDir,
): HostDoctorCheck {
  const code = pluginCode(scopes, enabled);
  const status: HostCheckStatus = code === "INSTALLED" ? "OK" : "WARN";
  const described = describeClaudePlugin(code, scopes, configDir);

  return {
    json: { id: "claude-plugin", status, code, scopes },
    message: described.message,
    annotation: described.annotation,
  };
}

function configDirCheck(configDir: ClaudeConfigDir): HostDoctorCheck {
  const described = describeClaudeConfigDir(configDir);

  return {
    json: {
      id: "claude-config",
      status: "OK",
      code: configDir.source === "DEFAULT" ? "CONFIG_DIR_DEFAULT" : "CONFIG_DIR_OVERRIDE",
      configDir: configDir.dir,
    },
    message: described.message,
    annotation: described.annotation,
  };
}
