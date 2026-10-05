import type { HookEvent } from "../hook-event";
import type { ClosingEvent, QuiescentUnit, UnitSplit } from "./types";

function closingEvent(event: HookEvent): ClosingEvent | null {
  if (event.agentId !== null) return null;
  if (event.name === "StopFailure") return event;
  if (event.name === "Stop" && event.backgroundTasks !== "ACTIVE") return event;

  return null;
}

/** Whether the event closes a quiescent unit; the same rule `splitQuiescentUnits` applies. */
export function isClosingEvent(event: HookEvent): boolean {
  return closingEvent(event) !== null;
}

/**
 * Splits one session's ordered events into quiescent units. A unit closes at the first
 * main-agent `Stop` whose background tasks are not active, or at a main `StopFailure`;
 * subagent events never close it. Events after the last closure stay open.
 */
export function splitQuiescentUnits(events: readonly HookEvent[]): UnitSplit {
  const closed: QuiescentUnit[] = [];
  let start = 0;

  events.forEach((event, index) => {
    const closer = closingEvent(event);

    if (closer === null) return;

    closed.push({
      sessionId: closer.sessionId,
      ordinal: closed.length,
      events: events.slice(start, index + 1),
      closer,
    });
    start = index + 1;
  });

  return { closed, open: events.slice(start) };
}
