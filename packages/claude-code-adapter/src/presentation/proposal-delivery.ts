import {
  AGENT_NOTICE,
  AUTO_DELIVERY_MARKER,
  formatAgentDelivery,
  isAutoDeliveredTask,
  MAX_AGENT_DELIVERIES_PER_SESSION,
  PROPOSAL_END,
  PROPOSAL_MAX_TEXT_LENGTH,
  PROPOSAL_START,
  withinSessionLimit,
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

const CONTROL_CHARACTERS = /(?![\n\t])\p{Cc}/gu;
const TRUNCATION_MARKER = "\n[truncated]";
const MANUAL_APPLY_HEADING = /^\s*(?:#{1,6}\s*|\*\*)?manual apply\b[:\s*]*(.*)$/i;
const NEXT_SECTION = /^\s*(?:#{1,6}\s*|\*\*)?(?:strategy|why)\b\s*(?:\*\*)?\s*(?::|$)/i;

/** `agent` only when requested and the session is still under its delivery limit. */
export function decideDelivery(
  requested: ProposalDelivery,
  deliveredInSession: number,
): ProposalDelivery {
  return requested === "agent" && withinSessionLimit(deliveredInSession) ? "agent" : "user";
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
  chain?: ProposalView["chain"],
): ProposalView {
  const clean = sanitized(text);

  return {
    turnId,
    unit: unitLabelOf(turnId),
    text: bounded(clean),
    applyInstruction: bounded(extractManualApply(clean) ?? clean.trim()),
    delivery,
    ...(chain === undefined ? {} : { chain }),
  };
}

/**
 * The framed message an `agent` delivery submits; it opens with the automatic marker and
 * keeps the model text inside a delimited block, with any delimiter line removed from it.
 * A `remediate` chain adds the attempt, the findings and the constraints.
 */
export function agentDeliveryText(view: ProposalView): string {
  if (view.chain !== undefined) {
    return formatAgentDelivery({
      unit: view.unit,
      attempt: view.chain.attempt,
      maxAttempts: view.chain.maxAttempts,
      chainId: view.chain.chainId,
      findings: view.chain.findings,
      strategyText: view.text,
    });
  }

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

/** Line (and toast) for one remediation attempt sent to the agent. */
export function remediationSentLine(unit: string, attempt: number, maxAttempts: number): string {
  return `JevGuard sent remediation attempt ${attempt}/${maxAttempts} for ${unit} to the agent`;
}

/** Line (and toast) for a chain that ended without resolving; `code` says why. */
export function remediationStoppedLine(
  unit: string,
  attempt: number,
  maxAttempts: number,
  code: string,
): string {
  return `JevGuard remediation stopped · ${unit} · attempt ${attempt}/${maxAttempts} · ${code}`;
}

/** Line (and toast) for a chain whose findings all passed. */
export function remediationResolvedLine(unit: string, fixed: number, attempts: number): string {
  return `JevGuard remediation resolved · ${unit} · ${fixed} finding(s) fixed in ${attempts} attempt(s)`;
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
