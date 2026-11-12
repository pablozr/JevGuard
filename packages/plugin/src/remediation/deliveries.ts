import { withinSessionLimit } from "@jevguard/core";
import type { DeliveryLedger } from "./types";

const MAX_COUNTED_SESSIONS = 1024;

interface SessionCount {
  readonly committed: number;
  readonly reserved: number;
}

const EMPTY: SessionCount = { committed: 0, reserved: 0 };

/**
 * Counts deliveries per session in memory. Past `maxSessions` counted sessions the least
 * recently used one is forgotten and its allowance starts over, so the map cannot grow forever.
 */
export function createDeliveryLedger(maxSessions: number = MAX_COUNTED_SESSIONS): DeliveryLedger {
  const sessions = new Map<string, SessionCount>();

  function store(sessionID: string, count: SessionCount): void {
    sessions.delete(sessionID);
    sessions.set(sessionID, count);

    for (const known of sessions.keys()) {
      if (sessions.size <= maxSessions) break;

      sessions.delete(known);
    }
  }

  function countOf(sessionID: string): SessionCount {
    return sessions.get(sessionID) ?? EMPTY;
  }

  return {
    used(sessionID) {
      const { committed, reserved } = countOf(sessionID);

      return committed + reserved;
    },

    reserve(sessionID) {
      const { committed, reserved } = countOf(sessionID);

      if (!withinSessionLimit(committed + reserved)) return false;

      store(sessionID, { committed, reserved: reserved + 1 });

      return true;
    },

    commit(sessionID) {
      const { committed, reserved } = countOf(sessionID);

      store(sessionID, { committed: committed + 1, reserved: Math.max(0, reserved - 1) });
    },

    release(sessionID) {
      const { committed, reserved } = countOf(sessionID);

      store(sessionID, { committed, reserved: Math.max(0, reserved - 1) });
    },
  };
}
