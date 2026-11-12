import { jevguardClaudeDataBaseOf, SESSION_ID } from "./feed-path";
import { sessionTurnPrefixOf } from "./turn-id";
import type { FeedEnvironment } from "./types";

const PROPOSALS_SUBPATH = "proposals";
const TURN_SUFFIX = /^(?:([0-9a-f]{16}):)?(0|[1-9][0-9]*)$/;

/** Directory that holds every private proposal request, or `null` when no absolute base exists. */
export function proposalDirectoryOf(environment: FeedEnvironment): string | null {
  const base = jevguardClaudeDataBaseOf(environment);

  return base === null ? null : `${base}/${PROPOSALS_SUBPATH}`;
}

/**
 * Request file of one unit, or `null` when the session id is not a safe file name or the
 * turn id does not belong to that session. The worker and the mod both call this.
 */
export function proposalRequestFileOf(
  environment: FeedEnvironment,
  sessionId: string,
  turnId: string,
): string | null {
  const directory = proposalDirectoryOf(environment);
  const prefix = sessionTurnPrefixOf(sessionId);

  if (directory === null || !SESSION_ID.test(sessionId) || !turnId.startsWith(prefix)) return null;

  const suffix = TURN_SUFFIX.exec(turnId.slice(prefix.length));

  if (suffix === null) return null;

  const [, epoch, ordinal] = suffix;
  const name = epoch === undefined ? `${ordinal}` : `${epoch}-${ordinal}`;

  return `${directory}/${sessionId}/${name}.json`;
}
