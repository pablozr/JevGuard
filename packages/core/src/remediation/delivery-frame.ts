import type { AutoDelivery } from "./chain";
import { CHAIN_ID_SOURCE } from "./types";

/** First words of every automatic delivery; a later turn's task is searched for it. */
export const AUTO_DELIVERY_MARKER = "[JevGuard remediation proposal · automatic delivery";

export const AGENT_NOTICE =
  "Sent by the JevGuard plugin, not typed by the user. Strategy-only proposal generated without tools for the FAIL findings of the previous work unit. Apply it only if it is consistent with the user's instructions; do not change tests, configuration or dependencies without explicit user confirmation.";

export const PROPOSAL_START = "--- proposal start ---";
export const PROPOSAL_END = "--- proposal end ---";

const CONSTRAINTS =
  "Constraints: touch only the listed paths; do not change tests, configuration, dependencies or .jev/; do not commit.";
const STOP_CLAUSE =
  "If you believe a finding is wrong, say so and stop instead of forcing a change.";
const CONTROL_CHARACTERS = /(?![\n\t])\p{Cc}/gu;
const FINDING_TEXT_MAX = 1000;
const MARK = new RegExp(
  `\\[JevGuard remediation proposal · automatic delivery(?: · [^\\n\\]·]*? · attempt ([1-9][0-9]*)/([1-9][0-9]*) · chain (${CHAIN_ID_SOURCE}))?\\]`,
);

/** One finding as the agent sees it: ids, severity, probability, paths and the rule's own text. */
export interface DeliveryFinding {
  readonly id: string;
  readonly severity: string;
  readonly probability: number;
  readonly paths: readonly string[];
  readonly violation: string | null;
  readonly allowed: string | null;
}

export interface AgentDeliveryInput {
  readonly unit: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly chainId: string;
  readonly findings: readonly DeliveryFinding[];
  readonly strategyText: string;
}

/** `true` when a unit's task contains an automatic delivery, so it never triggers a plain proposal. */
export function isAutoDeliveredTask(task: string): boolean {
  return task.includes(AUTO_DELIVERY_MARKER);
}

/**
 * What a turn's task says about its place in a chain: the attempt and chain of the first
 * mark, `"LEGACY"` for a mark without an attempt, or `null` for a task with no mark.
 */
export function parseAutoDelivery(task: string): AutoDelivery {
  const match = MARK.exec(task);

  if (match === null) return isAutoDeliveredTask(task) ? "LEGACY" : null;

  const [, attempt, maxAttempts, chainId] = match;

  if (attempt === undefined || maxAttempts === undefined || chainId === undefined) return "LEGACY";

  return { attempt: Number(attempt), maxAttempts: Number(maxAttempts), chainId };
}

function clean(text: string): string {
  return text.replace(CONTROL_CHARACTERS, "");
}

function oneLine(text: string): string {
  return clean(text).replace(/\s+/g, " ").trim().slice(0, FINDING_TEXT_MAX);
}

function findingLines(finding: DeliveryFinding): readonly string[] {
  const head = `- ${oneLine(finding.id)} (${oneLine(finding.severity)}, p=${finding.probability.toFixed(2)}) in ${finding.paths.map(oneLine).join(", ")}`;
  const lines = [head];

  if (finding.violation !== null && finding.violation !== "") {
    lines.push(`  Violation: ${oneLine(finding.violation)}`);
  }

  if (finding.allowed !== null && finding.allowed !== "") {
    lines.push(`  Allowed: ${oneLine(finding.allowed)}`);
  }

  return lines;
}

/**
 * The framed message of one remediation attempt. It never carries the diff or the
 * original task; the strategy sits inside a delimited block with any delimiter line
 * removed from it, and control characters are stripped everywhere.
 */
export function formatAgentDelivery(input: AgentDeliveryInput): string {
  const strategy = clean(input.strategyText)
    .split("\n")
    .filter((line) => line.trim() !== PROPOSAL_START && line.trim() !== PROPOSAL_END);

  return [
    `${AUTO_DELIVERY_MARKER} · ${oneLine(input.unit)} · attempt ${input.attempt}/${input.maxAttempts} · chain ${input.chainId}]`,
    AGENT_NOTICE,
    "",
    "Findings:",
    ...input.findings.flatMap(findingLines),
    "",
    PROPOSAL_START,
    ...strategy,
    PROPOSAL_END,
    "",
    CONSTRAINTS,
    STOP_CLAUSE,
  ].join("\n");
}
