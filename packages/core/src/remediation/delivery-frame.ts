import {
  type AgentDeliveryInput,
  DELIVERY_MAX_FINDING_TEXT_LENGTH,
  type DeliveryFinding,
  type FindingLocation,
  REMEDIATION_MAX_TASK_LENGTH,
} from "./types";

/** First words of every automatic delivery; a later turn's task is searched for it. */
export const AUTO_DELIVERY_MARKER = "[JevGuard remediation proposal · automatic delivery";

export const AGENT_NOTICE =
  "Sent by the JevGuard plugin, not typed by the user. These are the FAIL findings of the previous work unit, with a strategy-only proposal generated without tools when one is available. Apply it only if it is consistent with the user's instructions; do not change tests, configuration or dependencies without explicit user confirmation.";

export const PROPOSAL_START = "--- proposal start ---";
export const PROPOSAL_END = "--- proposal end ---";

export const NO_STRATEGY_NOTICE =
  "No strategy is available (no proposal could be drafted for this unit). Fix the findings above directly, within the constraints below.";

const CONSTRAINTS =
  "Constraints: touch only the listed paths; do not change tests, configuration, dependencies or .jev/; do not commit.";
const STOP_CLAUSE =
  "If you believe a finding is wrong, say so and stop instead of forcing a change.";
const CONTROL_CHARACTERS = /(?![\n\t])\p{Cc}/gu;
const TRUNCATION_MARKER = "\n[truncated]";

/** `true` when a unit's task contains an automatic delivery, so it never triggers a plain proposal. */
export function isAutoDeliveredTask(task: string): boolean {
  return task.includes(AUTO_DELIVERY_MARKER);
}

/** The text without control characters; tabs and newlines stay. */
export function stripControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, "");
}

/**
 * Proposer text without control characters, cut to `max` characters. A cut text ends with
 * a `[truncated]` line that counts toward `max`.
 */
export function boundProposalText(text: string, max: number): string {
  const clean = stripControlCharacters(text);

  if (clean.length <= max) {
    return clean;
  }

  if (max <= TRUNCATION_MARKER.length) {
    return clean.slice(0, Math.max(0, max));
  }

  return `${clean.slice(0, max - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function oneLine(text: string): string {
  return stripControlCharacters(text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DELIVERY_MAX_FINDING_TEXT_LENGTH);
}

function locationText(location: FindingLocation): string {
  const path = oneLine(location.path);

  if (location.hunk === null) return path;

  const { ordinal, newStart, newLines } = location.hunk;

  return `${path} hunk #${ordinal} (+${newStart},${newLines})`;
}

function findingLines(finding: DeliveryFinding): readonly string[] {
  const lines = [
    `- ${oneLine(finding.id)} — ${oneLine(finding.description)} (${oneLine(finding.severity)}, p=${finding.probability.toFixed(2)})`,
  ];

  if (finding.violation !== "") lines.push(`  Violation: ${oneLine(finding.violation)}`);
  if (finding.allowed !== "") lines.push(`  Allowed: ${oneLine(finding.allowed)}`);
  if (finding.locations.length > 0) {
    lines.push(`  Location: ${finding.locations.map(locationText).join("; ")}`);
  }

  return lines;
}

function omittedLines(omitted: number): readonly string[] {
  return omitted > 0 ? [`+${omitted} more findings not listed`] : [];
}

function withoutDelimiters(strategyText: string): string {
  return stripControlCharacters(strategyText)
    .split("\n")
    .filter((line) => line.trim() !== PROPOSAL_START && line.trim() !== PROPOSAL_END)
    .join("\n");
}

function frameOf(
  unit: string,
  findings: readonly DeliveryFinding[],
  omitted: number,
  strategy: string | null,
): string {
  return [
    `${AUTO_DELIVERY_MARKER} · ${oneLine(unit)}]`,
    AGENT_NOTICE,
    "",
    "Findings:",
    ...findings.flatMap(findingLines),
    ...omittedLines(omitted),
    "",
    ...(strategy === null ? [NO_STRATEGY_NOTICE] : [PROPOSAL_START, strategy, PROPOSAL_END]),
    "",
    CONSTRAINTS,
    STOP_CLAUSE,
  ].join("\n");
}

/**
 * The framed message of one remediation delivery. It never carries the diff or the
 * original task; the strategy, when there is one, sits inside a delimited block with
 * any delimiter line removed from it, and control characters are stripped everywhere.
 * The whole message stays within `REMEDIATION_MAX_TASK_LENGTH`, because it becomes the
 * next turn's task: findings are dropped from the end (and counted as omitted) only when
 * they alone would not fit, then the strategy is cut to what is left.
 */
export function formatAgentDelivery(input: AgentDeliveryInput): string {
  const strategy = input.strategyText === null ? null : withoutDelimiters(input.strategyText);
  const emptyStrategy = strategy === null ? null : "";
  let kept = input.findings.length;

  const frameWith = (count: number, text: string | null): string =>
    frameOf(
      input.unit,
      input.findings.slice(0, count),
      input.omitted + input.findings.length - count,
      text,
    );

  while (kept > 0 && frameWith(kept, emptyStrategy).length > REMEDIATION_MAX_TASK_LENGTH) {
    kept -= 1;
  }

  const base = frameWith(kept, emptyStrategy);

  if (strategy === null) return base;

  const budget = REMEDIATION_MAX_TASK_LENGTH - base.length;

  return frameWith(kept, boundProposalText(strategy, budget));
}
