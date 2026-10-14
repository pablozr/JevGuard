import type { FeedEnvironment } from "./types";

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|[\\/])/;
const TRAILING_SEPARATORS = /[\\/]+$/;
const DEFAULT_DATA_SUBPATH = ".local/share";
const CLAUDE_DATA_SUBPATH = "jevguard/claude-code";
const FEED_SUBPATH = "feed";

/** The process variables the feed and the proposal requests derive their location from. */
export const FEED_ENVIRONMENT_VARIABLES = {
  xdgDataHome: "XDG_DATA_HOME",
  userProfile: "USERPROFILE",
  home: "HOME",
} as const;

/** A session id that is safe to use as a file or directory name. */
export const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function absoluteOrNull(value: string | undefined): string | null {
  return value !== undefined && ABSOLUTE_PATH.test(value) ? value : null;
}

/**
 * Base directory of a user-level location: an absolute XDG value, else
 * `<USERPROFILE | HOME>/<defaultSubpath>`, without a trailing separator; `null` when no
 * absolute base exists.
 */
export function userBaseOf(
  xdgValue: string | undefined,
  userProfile: string | undefined,
  home: string | undefined,
  defaultSubpath: string,
): string | null {
  const explicit = absoluteOrNull(xdgValue);
  const profile = userProfile === "" ? undefined : userProfile;
  const homeDirectory = absoluteOrNull(profile ?? home);
  const homeBase =
    homeDirectory === null
      ? null
      : `${homeDirectory.replace(TRAILING_SEPARATORS, "")}/${defaultSubpath}`;
  const base = explicit ?? homeBase;

  return base === null ? null : base.replace(TRAILING_SEPARATORS, "");
}

/**
 * Directory under the user's data home that holds every JevGuard Claude Code file, or
 * `null` when no absolute base exists. The feed and the proposal requests share it.
 */
export function jevguardClaudeDataBaseOf(environment: FeedEnvironment): string | null {
  const base = userBaseOf(
    environment.xdgDataHome,
    environment.userProfile,
    environment.home,
    DEFAULT_DATA_SUBPATH,
  );

  return base === null ? null : `${base}/${CLAUDE_DATA_SUBPATH}`;
}

/**
 * Directory of the per-session review feed, or `null` when no absolute base exists.
 * The worker and the in-session mod both call this, so they always agree.
 */
export function reviewFeedDirectoryOf(environment: FeedEnvironment): string | null {
  const base = jevguardClaudeDataBaseOf(environment);

  return base === null ? null : `${base}/${FEED_SUBPATH}`;
}

/** Feed file of one session, or `null` when the session id is not a safe file name. */
export function reviewFeedFileOf(environment: FeedEnvironment, sessionId: string): string | null {
  const directory = reviewFeedDirectoryOf(environment);

  if (directory === null || !SESSION_ID.test(sessionId)) return null;

  return `${directory}/${sessionId}.jsonl`;
}
