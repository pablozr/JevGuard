export const TURN_ID_PREFIX = "claude-code:";

/** Prefix shared by every turn id of one Claude Code session. */
export function sessionTurnPrefixOf(sessionId: string): string {
  return `${TURN_ID_PREFIX}${sessionId}:`;
}
