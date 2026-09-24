import { PROPOSER_AGENT_NAME, PROPOSER_AGENT_PROMPT } from "@jevguard/core";

/**
 * Registers the internal remediation subagent on the host's live config object. The
 * name is owned deterministically: any pre-existing agent of the same name is
 * replaced rather than preserved, because the plugin invokes exactly that agent and
 * a preserved user definition could re-enable tools. The subagent mode, wildcard-deny
 * permissions, and wildcard-disabled tools together mean it cannot execute a tool,
 * edit a file, or produce a patch. No command is registered. Unrelated agents are
 * left untouched.
 */
export function registerRemediationConfig(config: unknown): void {
  if (!isRecord(config)) {
    return;
  }

  const agents = ensureRecord(config, "agent");

  if (agents === null) {
    return;
  }

  agents[PROPOSER_AGENT_NAME] = {
    mode: "subagent",
    hidden: true,
    description: "Internal JevGuard subagent that drafts a remediation proposal without tools.",
    prompt: PROPOSER_AGENT_PROMPT,
    tools: { "*": false },
    permission: { "*": "deny" },
  };
}

function ensureRecord(
  parent: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const current = parent[key];

  if (current === undefined) {
    const created: Record<string, unknown> = {};

    parent[key] = created;

    return created;
  }

  return isRecord(current) ? current : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
