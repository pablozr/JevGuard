import {
  AUTO_DELIVERY_MARKER,
  boundProposalText,
  type DeliveryFinding,
  formatAgentDelivery,
  isAutoDeliveredTask,
  MAX_AGENT_DELIVERIES_PER_SESSION,
  PROPOSAL_MAX_TEXT_LENGTH,
  stripControlCharacters,
} from "@jevguard/core";
import { unitLabelOf } from "./describe-review";
import type { ProposalDelivery, ProposalFailureCode, ProposalView } from "./types";

export {
  AUTO_DELIVERY_MARKER,
  isAutoDeliveredTask,
  MAX_AGENT_DELIVERIES_PER_SESSION,
  PROPOSAL_MAX_TEXT_LENGTH,
};

export const PROPOSAL_MAX_TOKENS = 4096;
export const PROPOSAL_TIMEOUT_MS = 180_000;
export const PROPOSAL_LOG_CHUNK = 1900;

const MANUAL_APPLY_HEADING = /^\s*(?:#{1,6}\s*|\*\*)?manual apply\b[:\s*]*(.*)$/i;
const NEXT_SECTION = /^\s*(?:#{1,6}\s*|\*\*)?(?:strategy|why)\b\s*(?:\*\*)?\s*(?::|$)/i;

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

/** The model text without control characters (tabs and newlines stay), capped in length. */
export function toProposalView(
  turnId: string,
  text: string,
  delivery: ProposalDelivery,
  findings: readonly DeliveryFinding[],
): ProposalView {
  const clean = stripControlCharacters(text);

  return {
    turnId,
    unit: unitLabelOf(turnId),
    text: boundProposalText(clean, PROPOSAL_MAX_TEXT_LENGTH),
    applyInstruction: boundProposalText(
      extractManualApply(clean) ?? clean.trim(),
      PROPOSAL_MAX_TEXT_LENGTH,
    ),
    delivery,
    findings,
  };
}

/**
 * The framed message an `agent` delivery submits: every finding plus the proposer strategy,
 * or the findings alone when `strategyText` is `null` (no proposal, or the proposer failed).
 */
export function agentDeliveryText(
  unit: string,
  findings: readonly DeliveryFinding[],
  omitted: number,
  strategyText: string | null,
): string {
  return formatAgentDelivery({ unit, findings, omitted, strategyText });
}

export function proposalReadyToast(unit: string): string {
  return `JevGuard proposal ready · ${unit}`;
}

export function proposalFailedToast(): string {
  return "JevGuard remediation proposal failed";
}

export function proposalFailureLine(unit: string, code: ProposalFailureCode): string {
  return `JevGuard proposal unavailable · ${unit} · ${code}`;
}

export function agentDeliveredLine(unit: string): string {
  return `JevGuard sent the findings for ${unit} to the agent`;
}

export function proposalLimitLine(unit: string): string {
  return `JevGuard agent delivery limit reached · ${unit} · shown here instead`;
}

export function proposalOtherSessionLine(unit: string): string {
  return `JevGuard remediation not sent · other session · ${unit}`;
}

/** Line (and toast) when the user's remediation file is invalid, so proposals are off. */
export function remediationConfigLine(code: string): string {
  return `JevGuard remediation is off · your claude-code.yaml is not valid (${code}) · see docs/configuration.md`;
}

/** Splits `text` into pieces of at most `max` characters, in order. */
export function chunkText(text: string, max: number): string[] {
  const chunks: string[] = [];

  for (let start = 0; start < text.length; start += max) {
    chunks.push(text.slice(start, start + max));
  }

  return chunks;
}
