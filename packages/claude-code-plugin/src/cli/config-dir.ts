import { join } from "node:path";
import type { HostCliContext } from "@jevguard/node-infra";
import { CLAUDE_CONFIG_DIR_VARIABLE } from "./constants";
import type { ClaudeConfigDir } from "./types";

/**
 * The directory Claude Code reads its plugins from: `CLAUDE_CONFIG_DIR` when set (as
 * `claude` itself does, which is how agent platforms isolate each agent), otherwise
 * `~/.claude`. Only the path is reported; nothing inside it is ever read.
 */
export function claudeConfigDirOf(
  context: Pick<HostCliContext, "variable" | "homedir">,
): ClaudeConfigDir {
  const override = context.variable(CLAUDE_CONFIG_DIR_VARIABLE)?.trim();

  if (override !== undefined && override !== "") {
    return { dir: override, source: CLAUDE_CONFIG_DIR_VARIABLE };
  }

  return { dir: join(context.homedir, ".claude"), source: "DEFAULT" };
}
