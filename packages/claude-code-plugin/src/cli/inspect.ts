import type { HostCliContext, HostInstallInspection, HostInstallScope } from "@jevguard/node-infra";
import { CLAUDE_COMMAND, CLAUDE_LIST_TIMEOUT_MS, MARKETPLACE_NAME, PLUGIN_ID } from "./constants";
import type { ClaudePluginScope } from "./types";

const PLUGIN_SCOPES: Record<HostInstallScope, ClaudePluginScope> = {
  global: "user",
  project: "project",
};

export function pluginScopeOf(scope: HostInstallScope): ClaudePluginScope {
  return PLUGIN_SCOPES[scope];
}

function parseJsonArray(output: string): readonly unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(output);

    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function listJson(
  context: Pick<HostCliContext, "processes">,
  args: readonly string[],
): Promise<readonly unknown[] | null> {
  const result = await context.processes.run({
    command: CLAUDE_COMMAND,
    args,
    timeoutMs: CLAUDE_LIST_TIMEOUT_MS,
  });

  if (result.kind !== "EXITED" || result.exitCode !== 0) return null;

  return parseJsonArray(result.stdout);
}

/** The entries of `claude plugin list --json`, or `null` when they cannot be read. */
export function readPluginEntries(context: HostCliContext): Promise<readonly unknown[] | null> {
  return listJson(context, ["plugin", "list", "--json"]);
}

/** Whether the JevGuard plugin is in one scope of the plugin list; `UNKNOWN` without a list. */
export function inspectScope(
  entries: readonly unknown[] | null,
  scope: HostInstallScope,
): HostInstallInspection {
  const target = `${PLUGIN_ID} (${pluginScopeOf(scope)} scope)`;

  if (entries === null) return { state: "UNKNOWN", target };

  const installed = entries.some(
    (entry) => isRecord(entry) && entry.id === PLUGIN_ID && entry.scope === pluginScopeOf(scope),
  );

  return { state: installed ? "INSTALLED" : "NOT_INSTALLED", target };
}

/** Whether an installed JevGuard entry in this scope is switched on (absent means on). */
export function isScopeEnabled(
  entries: readonly unknown[] | null,
  scope: HostInstallScope,
): boolean {
  return (entries ?? []).some(
    (entry) =>
      isRecord(entry) &&
      entry.id === PLUGIN_ID &&
      entry.scope === pluginScopeOf(scope) &&
      entry.enabled !== false,
  );
}

/** Whether the JevGuard plugin is installed in one Claude Code scope; `UNKNOWN` when unreadable. */
export async function inspectPlugin(
  context: HostCliContext,
  scope: HostInstallScope,
): Promise<HostInstallInspection> {
  return inspectScope(await readPluginEntries(context), scope);
}

/** Whether the JevGuard marketplace is already configured; `null` when unreadable. */
export async function isMarketplaceConfigured(context: HostCliContext): Promise<boolean | null> {
  const entries = await listJson(context, ["plugin", "marketplace", "list", "--json"]);

  if (entries === null) return null;

  return entries.some((entry) => isRecord(entry) && entry.name === MARKETPLACE_NAME);
}
