import type { HookEvent } from "../hook-event";
import { attributeToolEvents } from "./attribute-tools";
import type {
  AcquiredFile,
  AcquireUnitInput,
  ClaudeAcquisitionReason,
  FileImage,
  PostImage,
  QuiescentUnit,
  UnitAcquisition,
  UnitAttribution,
} from "./types";

const REASON_ORDER: readonly ClaudeAcquisitionReason[] = [
  "TURN_FAILED",
  "BACKGROUND_STATE_UNKNOWN",
  "MISSING_PROMPT",
  "PROMPT_NOT_TEXT",
  "BLOCKED_PATH",
  "MISSING_PATH",
  "PATH_OUTSIDE_REPOSITORY",
  "SHELL_BACKGROUND",
  "SHELL_CHANGED_OUTSIDE_UNIVERSE",
  "SHELL_GIT_DIFF_UNAVAILABLE",
  "MCP_TOOL",
  "UNKNOWN_TOOL",
  "PAIRING_BROKEN",
  "CAPTURE_FAILED",
  "CONTENT_TOO_LARGE",
  "CONTENT_NOT_TEXT",
  "MISSING_CAPTURE",
  "PATCH_BUDGET_EXCEEDED",
  "UNATTRIBUTED_WRITER",
];

type PromptReading =
  | { readonly status: "TEXT"; readonly prompts: readonly string[] }
  | { readonly status: "MISSING" }
  | { readonly status: "NOT_TEXT" };

function readPrompts(events: readonly HookEvent[]): PromptReading {
  const prompts: string[] = [];

  for (const event of events) {
    if (event.name !== "UserPromptSubmit") continue;
    if (event.prompt === null) return { status: "NOT_TEXT" };

    prompts.push(event.prompt);
  }

  return prompts.length === 0 ? { status: "MISSING" } : { status: "TEXT", prompts };
}

function closingReasons(unit: QuiescentUnit): readonly ClaudeAcquisitionReason[] {
  if (unit.closer.name === "StopFailure") return ["TURN_FAILED"];
  if (unit.closer.backgroundTasks === "UNKNOWN") return ["BACKGROUND_STATE_UNKNOWN"];

  return [];
}

interface AssembledFiles {
  readonly files: readonly AcquiredFile[];
  readonly reasons: ReadonlySet<ClaudeAcquisitionReason>;
}

function sameImage(final: FileImage, attributed: PostImage): boolean {
  if (final.state === "ABSENT") return attributed.state === "ABSENT";

  return attributed.state === "PRESENT" && attributed.digest === final.digest;
}

function assembleFiles(input: AcquireUnitInput, attribution: UnitAttribution): AssembledFiles {
  const files: AcquiredFile[] = [];
  const reasons = new Set<ClaudeAcquisitionReason>();

  for (const path of attribution.universe) {
    const before = attribution.preImages.get(path);
    const after = input.capture.finalImages.get(path);
    const attributed = attribution.lastPostImages.get(path);

    if (before === undefined || after === undefined || attributed === undefined) {
      reasons.add("MISSING_CAPTURE");
      continue;
    }

    if (!sameImage(after, attributed)) {
      reasons.add("UNATTRIBUTED_WRITER");
      continue;
    }

    files.push({ path, before, after });
  }

  return { files, reasons };
}

function unavailable(reasons: ReadonlySet<ClaudeAcquisitionReason>): UnitAcquisition {
  return { status: "UNAVAILABLE", reasons: REASON_ORDER.filter((reason) => reasons.has(reason)) };
}

/**
 * Decides one closed quiescent unit from its events and captured images. No file
 * outside the tool-named universe is ever consulted, and any unattributed or
 * incomplete evidence makes the unit `UNAVAILABLE` with typed reasons.
 */
export function acquireUnit(input: AcquireUnitInput): UnitAcquisition {
  const { unit } = input;
  const attribution = attributeToolEvents(input);
  const prompts = readPrompts(unit.events);
  const reasons = new Set<ClaudeAcquisitionReason>([
    ...closingReasons(unit),
    ...attribution.reasons,
    ...input.capture.problems,
  ]);

  if (prompts.status === "MISSING") reasons.add("MISSING_PROMPT");
  if (prompts.status === "NOT_TEXT") reasons.add("PROMPT_NOT_TEXT");
  if (reasons.size > 0 || prompts.status !== "TEXT") return unavailable(reasons);

  if (attribution.universe.size === 0) return { status: "SKIPPED", reason: "NO_ATTRIBUTED_PATCH" };

  const { files, reasons: assemblyReasons } = assembleFiles(input, attribution);

  if (assemblyReasons.size > 0) return unavailable(assemblyReasons);

  return {
    status: "READY",
    unit: { sessionId: unit.sessionId, ordinal: unit.ordinal, prompts: prompts.prompts, files },
  };
}
