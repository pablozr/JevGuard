import { checkHint, checkLine, type DescribedCheck } from "@jevguard/node-infra";
import type { ClaudePluginCheckCode, ScopeInspection } from "./types";

export function describeClaudePlugin(
  code: ClaudePluginCheckCode,
  scopes: readonly ScopeInspection[],
): DescribedCheck {
  switch (code) {
    case "INSTALLED":
      return checkLine(`JevGuard is installed in ${describeInstalledScopes(scopes)}.`);
    case "NOT_INSTALLED":
      return checkLine(
        "JevGuard is not installed in Claude Code.",
        checkHint("Run `jevguard install --host claude-code` (or add `--project`)."),
      );
    case "INSPECTION_FAILED":
      return checkLine(
        "The Claude Code plugin list could not be read.",
        checkHint(
          "Check that `claude plugin list --json` works, then run `jevguard doctor` again.",
        ),
      );
  }
}

function describeInstalledScopes(scopes: readonly ScopeInspection[]): string {
  return scopes
    .filter((entry) => entry.state === "INSTALLED")
    .map((entry) => entry.scope)
    .join(" and ");
}
