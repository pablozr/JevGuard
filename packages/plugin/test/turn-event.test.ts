import { describe, expect, test } from "vitest";
import { parseTurnEvent, TURN_EVENT_TYPES } from "../src/turn-event";

describe("parseTurnEvent", () => {
  test("reads started and succeeded executions from the data payload", () => {
    expect(
      parseTurnEvent({ type: "session.execution.started", data: { sessionID: "s1" } }),
    ).toEqual({ kind: "STARTED", sessionID: "s1" });
    expect(
      parseTurnEvent({ type: "session.execution.succeeded", data: { sessionID: "s1" } }),
    ).toEqual({ kind: "SUCCEEDED", sessionID: "s1" });
  });

  test("reads interrupted and failed executions as ended without review", () => {
    expect(
      parseTurnEvent({
        type: "session.execution.interrupted",
        data: { sessionID: "s1", reason: "user" },
      }),
    ).toEqual({ kind: "ENDED_OTHER", sessionID: "s1", reason: "interrupted" });
    expect(
      parseTurnEvent({
        type: "session.execution.failed",
        data: { sessionID: "s1", error: "boom" },
      }),
    ).toEqual({ kind: "ENDED_OTHER", sessionID: "s1", reason: "failed" });
  });

  test("ignores the V1 idle status event and any V1 properties payload", () => {
    expect(
      parseTurnEvent({
        type: "session.status",
        properties: { sessionID: "s1", status: { type: "idle" } },
      }),
    ).toBeNull();
    expect(
      parseTurnEvent({ type: "session.execution.succeeded", properties: { sessionID: "s1" } }),
    ).toBeNull();
    expect(parseTurnEvent({ type: "session.idle", data: { sessionID: "s1" } })).toBeNull();
  });

  test("ignores other events and missing or empty session IDs", () => {
    expect(parseTurnEvent({ type: "session.step.ended", data: { sessionID: "s1" } })).toBeNull();
    expect(
      parseTurnEvent({ type: "session.execution.succeeded", data: { sessionID: "" } }),
    ).toBeNull();
    expect(parseTurnEvent({ type: "session.execution.succeeded", data: {} })).toBeNull();
    expect(
      parseTurnEvent({ type: "session.execution.succeeded", data: { sessionID: 7 } }),
    ).toBeNull();
    expect(parseTurnEvent(null)).toBeNull();
    expect(parseTurnEvent("session.execution.succeeded")).toBeNull();
  });

  test("subscribes only to the four execution lifecycle events", () => {
    expect([...TURN_EVENT_TYPES]).toEqual([
      "session.execution.started",
      "session.execution.succeeded",
      "session.execution.interrupted",
      "session.execution.failed",
    ]);
  });
});
