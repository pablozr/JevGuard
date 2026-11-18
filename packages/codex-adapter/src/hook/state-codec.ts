import type { CodexSessionState, CodexStateLine, CodexTaintReason, CodexUnitState } from "./types";

/**
 * Reads the session's lifecycle file back into units.
 *
 * The file is written by this slice alone, so a line that does not match exactly is a
 * damaged file, never a reason to guess: `STATE_DAMAGED` is applied to the unit that was
 * open where the unreadable line appeared, or to the next unit to open when there was
 * none. A later unit never inherits an earlier unit's damage, and the mark is re-derived
 * from the same line on every read, so it is logged once per unit it reaches.
 */

const TAINTS: readonly CodexTaintReason[] = [
  "HOOK_NOT_TRUSTED",
  "TOOL_CALL_UNPAIRED",
  "TOOL_CALL_DUPLICATED",
  "TURN_NOT_CLOSED",
  "UNSUPPORTED_EVENT",
  "PAYLOAD_UNREADABLE",
  "STATE_DAMAGED",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isTaint(value: unknown): value is CodexTaintReason {
  return typeof value === "string" && (TAINTS as readonly string[]).includes(value);
}

/** One line, or `null` when it is not exactly a line this slice wrote. */
export function decodeStateLine(text: string): CodexStateLine | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(value) || value.v !== 1) return null;

  switch (value.kind) {
    case "OPEN":
    case "CLOSE":
      return isText(value.turn) && isText(value.at)
        ? { v: 1, kind: value.kind, turn: value.turn, at: value.at }
        : null;
    case "CALL":
    case "PAIR":
      return isText(value.turn) && isText(value.call)
        ? { v: 1, kind: value.kind, turn: value.turn, call: value.call }
        : null;
    case "TAINT":
      return isText(value.turn) && isTaint(value.reason)
        ? { v: 1, kind: "TAINT", turn: value.turn, reason: value.reason }
        : null;
    case "SESSION_TAINT":
      return isTaint(value.reason) ? { v: 1, kind: "SESSION_TAINT", reason: value.reason } : null;
    default:
      return null;
  }
}

function tainted(unit: CodexUnitState, reasons: readonly CodexTaintReason[]): CodexUnitState {
  return { ...unit, taints: [...new Set([...unit.taints, ...reasons])] };
}

function openUnit(turn: string, at: string, taints: readonly CodexTaintReason[]): CodexUnitState {
  return { turnId: turn, openedAt: at, closedAt: null, calls: [], taints: [...new Set(taints)] };
}

function openUnitAt(units: readonly CodexUnitState[]): CodexUnitState | null {
  const unit = units.at(-1);

  return unit !== undefined && unit.closedAt === null ? unit : null;
}

/** Replaces the open unit, when there is one, and reads back what the line said. */
function updateOpenUnit(
  units: CodexUnitState[],
  update: (unit: CodexUnitState) => CodexUnitState,
): boolean {
  const index = units.length - 1;
  const unit = openUnitAt(units);

  if (unit === null) return false;

  units[index] = update(unit);

  return true;
}

/** Replays the lines in order; a line that cannot be read marks the unit it fell in. */
export function replayState(lines: readonly (CodexStateLine | null)[]): CodexSessionState {
  const units: CodexUnitState[] = [];
  let pendingTaints: CodexTaintReason[] = [];
  let damaged = false;

  for (const line of lines) {
    if (line === null) {
      damaged = true;

      if (!updateOpenUnit(units, (unit) => tainted(unit, ["STATE_DAMAGED"]))) {
        pendingTaints = [...new Set([...pendingTaints, "STATE_DAMAGED" as const])];
      }

      continue;
    }

    switch (line.kind) {
      case "SESSION_TAINT":
        if (!updateOpenUnit(units, (unit) => tainted(unit, [line.reason]))) {
          pendingTaints.push(line.reason);
        }
        break;
      case "OPEN":
        units.push(openUnit(line.turn, line.at, pendingTaints));
        pendingTaints = [];
        break;
      case "CALL":
        updateOpenUnit(units, (unit) => ({
          ...unit,
          calls: [...unit.calls, { toolUseId: line.call, paired: false }],
        }));
        break;
      case "PAIR":
        updateOpenUnit(units, (unit) => ({
          ...unit,
          calls: unit.calls.map((call) =>
            call.toolUseId === line.call ? { ...call, paired: true } : call,
          ),
        }));
        break;
      case "TAINT":
        if (!updateOpenUnit(units, (unit) => tainted(unit, [line.reason]))) {
          pendingTaints.push(line.reason);
        }
        break;
      case "CLOSE":
        updateOpenUnit(units, (unit) => ({ ...unit, closedAt: line.at }));
        break;
    }
  }

  return { units, pendingTaints, damaged };
}
