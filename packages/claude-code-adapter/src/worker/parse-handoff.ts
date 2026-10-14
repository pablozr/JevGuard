import { isAbsolute } from "node:path";
import type { Turn } from "@jevguard/core";
import type { ClaudeAcquisitionReason } from "../acquisition";
import type { ClaudeReviewHandoff, ShellCoverage } from "../capture/types";
import type { TurnResolution } from "../turn";
import type { HandoffParseResult } from "./types";

const KNOWN_CAUSES: Record<ClaudeAcquisitionReason, true> = {
  TURN_FAILED: true,
  BACKGROUND_STATE_UNKNOWN: true,
  MISSING_PROMPT: true,
  PROMPT_NOT_TEXT: true,
  BLOCKED_PATH: true,
  MISSING_PATH: true,
  PATH_OUTSIDE_REPOSITORY: true,
  SHELL_BACKGROUND: true,
  SHELL_CHANGED_OUTSIDE_UNIVERSE: true,
  SHELL_GIT_DIFF_UNAVAILABLE: true,
  SHELL_DIFF_LIMIT_EXCEEDED: true,
  MCP_TOOL: true,
  UNKNOWN_TOOL: true,
  PAIRING_BROKEN: true,
  CAPTURE_FAILED: true,
  CONTENT_TOO_LARGE: true,
  CONTENT_NOT_TEXT: true,
  MISSING_CAPTURE: true,
  PATCH_BUDGET_EXCEEDED: true,
  UNATTRIBUTED_WRITER: true,
};

function isKnownCause(value: unknown): value is ClaudeAcquisitionReason {
  return typeof value === "string" && Object.hasOwn(KNOWN_CAUSES, value);
}

const INVALID: HandoffParseResult = { status: "INVALID" };

function isShellCoverage(value: unknown): value is ShellCoverage {
  return value === "ADAPTER_GIT_DIFF";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function parseTurn(value: unknown): Turn | null {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.id) || typeof value.task !== "string") return null;
  if (!Array.isArray(value.files)) return null;

  const files: { path: string; patch: string }[] = [];

  for (const file of value.files) {
    if (!isRecord(file)) return null;
    if (typeof file.path !== "string" || typeof file.patch !== "string") return null;

    files.push({ path: file.path, patch: file.patch });
  }

  return { id: value.id, task: value.task, files };
}

function parseResolution(value: unknown): TurnResolution | null {
  if (!isRecord(value)) return null;

  if (value.status === "SKIPPED") {
    return value.reason === "NO_ATTRIBUTED_PATCH"
      ? { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" }
      : null;
  }

  if (value.status === "TURN") {
    const turn = parseTurn(value.turn);

    return turn === null ? null : { status: "TURN", turn };
  }

  if (value.status !== "UNAVAILABLE") return null;
  if (value.reason !== "MISSING_ATTRIBUTED_DIFF" && value.reason !== "BLOCKED_EVIDENCE") {
    return null;
  }
  if (!Array.isArray(value.causes) || !value.causes.every(isKnownCause)) return null;

  return { status: "UNAVAILABLE", reason: value.reason, causes: value.causes };
}

/** Validates an untrusted handoff file's text; anything off-shape is `INVALID`. */
export function parseHandoff(text: string): HandoffParseResult {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return INVALID;
  }

  if (!isRecord(raw) || raw.version !== 1) return INVALID;
  if (!isNonEmptyString(raw.turnId) || !isNonEmptyString(raw.sessionId)) return INVALID;
  if (!isNonEmptyString(raw.projectRoot) || !isAbsolute(raw.projectRoot)) return INVALID;
  if (!isNonEmptyString(raw.epoch)) return INVALID;
  if (typeof raw.ordinal !== "number" || !Number.isInteger(raw.ordinal)) return INVALID;
  if (typeof raw.closedAt !== "string" || Number.isNaN(Date.parse(raw.closedAt))) return INVALID;
  if (!Array.isArray(raw.shellCoverage) || !raw.shellCoverage.every(isShellCoverage)) {
    return INVALID;
  }

  const resolution = parseResolution(raw.resolution);

  if (resolution === null) return INVALID;
  if (resolution.status === "TURN" && resolution.turn.id !== raw.turnId) return INVALID;

  const handoff: ClaudeReviewHandoff = {
    version: 1,
    turnId: raw.turnId,
    sessionId: raw.sessionId,
    ordinal: raw.ordinal,
    projectRoot: raw.projectRoot,
    closedAt: raw.closedAt,
    shellCoverage: raw.shellCoverage,
    epoch: raw.epoch,
    resolution,
  };

  return { status: "VALID", handoff };
}
