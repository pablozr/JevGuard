import { detectHostVersion, type HostCliContext, type HostDetection } from "@jevguard/node-infra";
import { CLAUDE_COMMAND, CLAUDE_SUPPORTED_RANGE, CLAUDE_VERSION_TIMEOUT_MS } from "./constants";

export function detectClaudeCode(
  context: Pick<HostCliContext, "processes">,
): Promise<HostDetection> {
  return detectHostVersion(context.processes, {
    host: "claude-code",
    command: CLAUDE_COMMAND,
    range: CLAUDE_SUPPORTED_RANGE,
    timeoutMs: CLAUDE_VERSION_TIMEOUT_MS,
  });
}
