import type { HostCliContext, HostInstallOutcome, HostInstallScope } from "@jevguard/node-infra";
import { claudeConfigDirOf } from "./config-dir";
import {
  CLAUDE_COMMAND,
  CLAUDE_INSTALL_TIMEOUT_MS,
  MARKETPLACE_SOURCE,
  PLUGIN_ID,
} from "./constants";
import { detectClaudeCode } from "./detect";
import { inspectPlugin, isMarketplaceConfigured, pluginScopeOf } from "./inspect";
import {
  describeInstallAborted,
  describeInstallAlreadyInstalled,
  describeInstallFailure,
  describeInstallInstalled,
} from "./install-messages";
import type { ClaudeInstallFailureCode, ClaudePluginScope } from "./types";

function failed(code: ClaudeInstallFailureCode, scope: ClaudePluginScope): HostInstallOutcome {
  return { status: "FAILED", code, lines: describeInstallFailure(code, scope) };
}

async function runClaude(context: HostCliContext, args: readonly string[]): Promise<boolean> {
  const result = await context.processes.run({
    command: CLAUDE_COMMAND,
    args,
    timeoutMs: CLAUDE_INSTALL_TIMEOUT_MS,
  });

  return result.kind === "EXITED" && result.exitCode === 0;
}

async function addMarketplace(context: HostCliContext, scope: ClaudePluginScope): Promise<boolean> {
  if ((await isMarketplaceConfigured(context)) === true) return true;

  return runClaude(context, ["plugin", "marketplace", "add", MARKETPLACE_SOURCE, "--scope", scope]);
}

async function preflight(
  context: HostCliContext,
  scope: ClaudePluginScope,
): Promise<HostInstallOutcome | null> {
  const detection = await detectClaudeCode(context);

  if (detection.status === "NOT_FOUND") return failed("CLAUDE_NOT_FOUND", scope);

  if (detection.status === "UNSUPPORTED") return failed("VERSION_UNSUPPORTED", scope);

  return null;
}

async function confirmInstall(
  configDir: string,
  context: HostCliContext,
  scope: ClaudePluginScope,
): Promise<HostInstallOutcome | null> {
  const confirmation = await context.confirmation.confirm(
    `Install the JevGuard plugin for Claude Code (${scope} scope, config dir ${configDir})?`,
  );

  if (confirmation.status === "DECLINED") {
    return { status: "DECLINED", code: "ABORTED", lines: [describeInstallAborted()] };
  }

  return confirmation.status === "FAILED" ? failed("NOT_A_TTY", scope) : null;
}

/**
 * Adds the JevGuard marketplace and installs the plugin through the `claude plugin`
 * commands, after the user confirms. It never runs when the plugin is already there.
 */
export async function installClaudePlugin(
  context: HostCliContext,
  hostScope: HostInstallScope,
): Promise<HostInstallOutcome> {
  const scope = pluginScopeOf(hostScope);
  // `claude plugin ...` inherits the environment, so it reads and writes the plugins of
  // `CLAUDE_CONFIG_DIR` when set and never touches `~/.claude` then.
  const { dir: configDir } = claudeConfigDirOf(context);
  const blocked = await preflight(context, scope);

  if (blocked !== null) return blocked;

  if ((await inspectPlugin(context, hostScope)).state === "INSTALLED") {
    return {
      status: "UNCHANGED",
      code: "ALREADY_INSTALLED",
      lines: [describeInstallAlreadyInstalled(scope, configDir)],
    };
  }

  const refused = await confirmInstall(configDir, context, scope);

  if (refused !== null) return refused;

  if (!(await addMarketplace(context, scope))) return failed("MARKETPLACE_FAILED", scope);

  if (!(await runClaude(context, ["plugin", "install", PLUGIN_ID, "--scope", scope]))) {
    return failed("INSTALL_FAILED", scope);
  }

  return {
    status: "CHANGED",
    code: "INSTALLED",
    lines: [describeInstallInstalled(scope, configDir)],
  };
}
