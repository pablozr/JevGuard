import { describeReview, unitLabelOf } from "./describe-review";
import { sessionTurnPrefixOf } from "./turn-id";
import type {
  FeedWatch,
  ReviewDisplay,
  ReviewFeedLine,
  ReviewFeedRecorded,
  ReviewFeedStarted,
  WatchTick,
} from "./types";

export const POLL_INTERVAL_MS = 2000;
export const WATCH_WINDOW_MS = 45_000;
export const PENDING_MAX_MS = 150_000;
export const WATCH_CEILING_MS = 900_000;

interface SessionFeed {
  readonly recorded: readonly ReviewFeedRecorded[];
  readonly started: readonly ReviewFeedStarted[];
}

function ageOf(line: ReviewFeedLine, nowMs: number): number {
  return nowMs - Date.parse(line.at);
}

function uniqueByTurn<T extends ReviewFeedLine>(lines: readonly T[]): readonly T[] {
  const seen = new Set<string>();

  return lines.filter((line) => {
    if (seen.has(line.turnId)) return false;

    seen.add(line.turnId);

    return true;
  });
}

function sessionFeedOf(lines: readonly ReviewFeedLine[], sessionId: string): SessionFeed {
  const prefix = sessionTurnPrefixOf(sessionId);
  const mine = lines.filter((line) => line.turnId.startsWith(prefix));
  const recorded = mine.flatMap((line) => (line.kind === "RECORDED" ? [line] : []));
  const started = mine.flatMap((line) => (line.kind === "STARTED" ? [line] : []));

  return { recorded, started };
}

function openStarts(feed: SessionFeed): readonly ReviewFeedStarted[] {
  const recordedIds = new Set(feed.recorded.map((line) => line.turnId));

  return uniqueByTurn(feed.started.filter((line) => !recordedIds.has(line.turnId)));
}

function stillInFeed(ids: readonly string[], feed: SessionFeed): readonly string[] {
  const present = new Set([...feed.recorded, ...feed.started].map((line) => line.turnId));

  return [...new Set(ids)].filter((id) => present.has(id));
}

export function emptyWatch(): FeedWatch {
  return { shown: [], armedAtMs: null };
}

/**
 * Marks everything already in the feed as seen, so a reload never replays old reviews.
 * `shown` only keeps ids still in the feed, so it is bounded by the feed itself and an
 * id can never be forgotten while it could still be shown again.
 */
export function baselineWatch(
  lines: readonly ReviewFeedLine[],
  sessionId: string,
  nowMs: number,
): FeedWatch {
  const feed = sessionFeedOf(lines, sessionId);
  const open = openStarts(feed);
  const pending = open.filter((line) => ageOf(line, nowMs) <= PENDING_MAX_MS);
  const oldStarts = open.filter((line) => ageOf(line, nowMs) > PENDING_MAX_MS);
  const shown = [...feed.recorded, ...oldStarts].map((line) => line.turnId);

  return { shown: stillInFeed(shown, feed), armedAtMs: pending.length > 0 ? nowMs : null };
}

export function armWatch(watch: FeedWatch, nowMs: number): FeedWatch {
  return { ...watch, armedAtMs: nowMs };
}

function watchStatusOf(
  pending: readonly ReviewFeedStarted[],
  displays: readonly ReviewDisplay[],
  stale: readonly ReviewFeedStarted[],
): string | null {
  const lastPending = pending.at(-1);

  if (lastPending !== undefined) return `JevGuard reviewing ${unitLabelOf(lastPending.turnId)}...`;

  const lastDisplay = displays.at(-1);

  if (lastDisplay !== undefined) return lastDisplay.status;

  const lastStale = stale.at(-1);

  return lastStale === undefined
    ? null
    : `JevGuard · ${unitLabelOf(lastStale.turnId)} · no result yet (run jevguard report)`;
}

function shouldStop(armedAtMs: number | null, pendingCount: number, nowMs: number): boolean {
  if (armedAtMs === null) return true;

  const armedFor = nowMs - armedAtMs;

  return (pendingCount === 0 && armedFor > WATCH_WINDOW_MS) || armedFor > WATCH_CEILING_MS;
}

/** One poll: what to show now, the next watch state, and whether polling can stop. */
export function tickWatch(
  watch: FeedWatch,
  lines: readonly ReviewFeedLine[],
  sessionId: string,
  nowMs: number,
): WatchTick {
  const feed = sessionFeedOf(lines, sessionId);
  const shown = new Set(watch.shown);
  const fresh = uniqueByTurn(feed.recorded.filter((line) => !shown.has(line.turnId)));
  const open = openStarts(feed).filter((line) => !shown.has(line.turnId));
  const pending = open.filter((line) => ageOf(line, nowMs) <= PENDING_MAX_MS);
  const stale = open.filter((line) => ageOf(line, nowMs) > PENDING_MAX_MS);
  const displays = fresh.map(describeReview);
  const stop = shouldStop(watch.armedAtMs, pending.length, nowMs);

  return {
    watch: {
      shown: stillInFeed([...watch.shown, ...fresh.map((line) => line.turnId)], feed),
      armedAtMs: stop ? null : watch.armedAtMs,
    },
    displays,
    proposals: fresh.filter((line) => line.proposal === true).map((line) => line.turnId),
    status: watchStatusOf(pending, displays, stale),
    stop,
  };
}
