import { checkHint, checkLine, type DescribedCheck } from "@jevguard/node-infra";
import { CLAUDE_CONFIG_DIR_VARIABLE, PLUGIN_ID } from "./constants";
import type { ClaudeConfigDir, ClaudePluginCheckCode, ScopeInspection } from "./types";

export function describeClaudePlugin(
  code: ClaudePluginCheckCode,
  scopes: readonly ScopeInspection[],
  configDir: ClaudeConfigDir,
): DescribedCheck {
  switch (code) {
    case "INSTALLED":
      return checkLine(
        `JevGuard is installed and enabled in ${describeInstalledScopes(scopes)} (config dir ${configDir.dir}).`,
      );
    case "DISABLED":
      return checkLine(
        `JevGuard is installed but disabled in Claude Code (config dir ${configDir.dir}).`,
        checkHint(`Run \`claude plugin enable ${PLUGIN_ID}\` with the same config dir.`),
      );
    case "NOT_INSTALLED":
      return checkLine(
        `JevGuard is not installed in Claude Code (config dir ${configDir.dir}).`,
        checkHint(
          `Run \`jevguard install --host claude-code\` (or add \`--project\`) with ${CLAUDE_CONFIG_DIR_VARIABLE} set the way Claude Code runs.`,
        ),
      );
    case "INSPECTION_FAILED":
      return checkLine(
        `The Claude Code plugin list could not be read (config dir ${configDir.dir}).`,
        checkHint(
          "Check that `claude plugin list --json` works, then run `jevguard doctor` again.",
        ),
      );
  }
}

export function describeClaudeConfigDir(configDir: ClaudeConfigDir): DescribedCheck {
  return checkLine(
    configDir.source === "DEFAULT"
      ? `Claude Code config dir: ${configDir.dir} (default).`
      : `Claude Code config dir: ${configDir.dir} (from ${CLAUDE_CONFIG_DIR_VARIABLE}).`,
  );
}

function describeInstalledScopes(scopes: readonly ScopeInspection[]): string {
  return scopes
    .filter((entry) => entry.state === "INSTALLED")
    .map((entry) => entry.scope)
    .join(" and ");
}
