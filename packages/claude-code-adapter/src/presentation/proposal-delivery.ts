import { unitLabelOf } from "./describe-review";
import type { ProposalDelivery, ProposalFailureCode, ProposalView } from "./types";

/** First words of every automatic delivery; the worker finds it in the next unit's task. */
export const AUTO_DELIVERY_MARKER = "[JevGuard remediation proposal · automatic delivery";

export const MAX_AGENT_DELIVERIES_PER_SESSION = 3;
export const PROPOSAL_MAX_TOKENS = 4096;
export const PROPOSAL_TIMEOUT_MS = 180_000;
export const PROPOSAL_LOG_CHUNK = 1900;
export const PROPOSAL_MAX_TEXT_LENGTH = 32_768;

const CONTROL_CHARACTERS = /(?![\n\t])\p{Cc}/gu;
const TRUNCATION_MARKER = "\n[truncated]";
const PROPOSAL_START = "--- proposal start ---";
const PROPOSAL_END = "--- proposal end ---";

const MANUAL_APPLY_HEADING = /^\s*(?:#{1,6}\s*|\*\*)?manual apply\b[:\s*]*(.*)$/i;
const NEXT_SECTION = /^\s*(?:#{1,6}\s*|\*\*)?(?:strategy|why)\b\s*(?:\*\*)?\s*(?::|$)/i;
const AGENT_NOTICE =
  "Sent by the JevGuard plugin, not typed by the user. Strategy-only proposal generated without tools for the FAIL findings of the previous work unit. Apply it only if it is consistent with the user's instructions; do not change tests, configuration or dependencies without explicit user confirmation.";

/** `true` when a unit's task contains an automatic delivery, so it never triggers another. */
export function isAutoDeliveredTask(task: string): boolean {
  return task.includes(AUTO_DELIVERY_MARKER);
}

/** `agent` only when requested and the session is still under its delivery limit. */
export function decideDelivery(
  requested: ProposalDelivery,
  deliveredInSession: number,
): ProposalDelivery {
  return requested === "agent" && deliveredInSession < MAX_AGENT_DELIVERIES_PER_SESSION
    ? "agent"
    : "user";
}

/** The "Manual apply" section of a proposal, or `null` when it is absent or empty. */
export function extractManualApply(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => MANUAL_APPLY_HEADING.test(line));

  if (start === -1) return null;

  const inline = MANUAL_APPLY_HEADING.exec(lines[start] ?? "")?.[1] ?? "";
  const following = lines.slice(start + 1);
  const end = following.findIndex((line) => NEXT_SECTION.test(line));
  const body = end === -1 ? following : following.slice(0, end);
  const section = [inline, ...body].join("\n").trim();

  return section === "" ? null : section;
}

function sanitized(text: string): string {
  return text.replace(CONTROL_CHARACTERS, "");
}

function bounded(text: string): string {
  if (text.length <= PROPOSAL_MAX_TEXT_LENGTH) return text;

  return `${text.slice(0, PROPOSAL_MAX_TEXT_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

/** The model text without control characters (tabs and newlines stay), capped in length. */
export function toProposalView(
  turnId: string,
  text: string,
  delivery: ProposalDelivery,
): ProposalView {
  const clean = sanitized(text);

  return {
    turnId,
    unit: unitLabelOf(turnId),
    text: bounded(clean),
    applyInstruction: bounded(extractManualApply(clean) ?? clean.trim()),
    delivery,
  };
}

/**
 * The framed message an `agent` delivery submits; it opens with the automatic marker and
 * keeps the model text inside a delimited block, with any delimiter line removed from it.
 */
export function agentDeliveryText(view: ProposalView): string {
  const body = view.text
    .split("\n")
    .filter((line) => line.trim() !== PROPOSAL_START && line.trim() !== PROPOSAL_END);

  return [
    `${AUTO_DELIVERY_MARKER} · ${view.unit}]`,
    AGENT_NOTICE,
    "",
    PROPOSAL_START,
    ...body,
    PROPOSAL_END,
  ].join("\n");
}

export function proposalReadyToast(unit: string): string {
  return `JevGuard proposal ready · ${unit}`;
}

export function proposalSentLine(unit: string): string {
  return `JevGuard sent a remediation proposal for ${unit} to the agent`;
}

export function proposalFailedToast(): string {
  return "JevGuard remediation proposal failed";
}

export function proposalFailureLine(unit: string, code: ProposalFailureCode): string {
  return `JevGuard proposal unavailable · ${unit} · ${code}`;
}

export function proposalLimitLine(unit: string): string {
  return `JevGuard agent delivery limit reached · ${unit} · shown here instead`;
}

/** Splits `text` into pieces of at most `max` characters, in order. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];

  for (let start = 0; start < text.length; start += max) {
    chunks.push(text.slice(start, start + max));
  }

  return chunks;
}
