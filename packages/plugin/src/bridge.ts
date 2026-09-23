import {
  encodeReviewBridge,
  type ParsedRule,
  type ReviewResult,
  type RuleParseResults,
} from "@jevguard/core";
import type { ReviewBridgePort } from "@jevguard/opencode-adapter";

/** The evaluated turn context plus its aggregated results and parsed rule source. */
export interface ReviewBridgeDispatch {
  readonly sessionID: string;
  readonly messageID: string;
  readonly rules: RuleParseResults;
  readonly results: readonly ReviewResult[];
}

/**
 * Dispatches at most one bridge command per local `error` rule that reached `FAIL`,
 * using the exact parsed rule that produced the result. Built-in checks, `warning`
 * rules, every other outcome, and rejected encodings emit nothing. Each command is
 * isolated so a transport failure never affects the review, presentation, or later
 * turns, and no payload, diff, or secret is logged.
 */
export async function dispatchReviewBridge(
  dispatch: ReviewBridgeDispatch,
  bridge: ReviewBridgePort,
): Promise<void> {
  for (const command of safeEncodeFailureCommands(dispatch)) {
    await executeCommand(bridge, command);
  }
}

function safeEncodeFailureCommands(dispatch: ReviewBridgeDispatch): readonly string[] {
  try {
    return encodeFailureCommands(dispatch);
  } catch {
    return [];
  }
}

function encodeFailureCommands(dispatch: ReviewBridgeDispatch): readonly string[] {
  const rulesById = indexParsedRules(dispatch.rules);
  const commands: string[] = [];

  for (const result of dispatch.results) {
    if (result.kind !== "RULE" || result.outcome !== "FAIL") {
      continue;
    }

    if (result.severity !== "error" || result.ruleId === null) {
      continue;
    }

    const rule = rulesById.get(result.ruleId);

    if (rule === undefined) {
      continue;
    }

    const encoded = encodeReviewBridge({
      sessionID: dispatch.sessionID,
      messageID: dispatch.messageID,
      rule,
      probability: result.violationProbability,
    });

    if (encoded.status === "ENCODED") {
      commands.push(encoded.command);
    }
  }

  return commands;
}

function indexParsedRules(rules: RuleParseResults): ReadonlyMap<string, ParsedRule> {
  const byId = new Map<string, ParsedRule>();

  for (const candidate of rules) {
    if (candidate.status === "PARSED") {
      byId.set(candidate.rule.id, candidate.rule);
    }
  }

  return byId;
}

async function executeCommand(bridge: ReviewBridgePort, command: string): Promise<void> {
  try {
    await bridge.execute(command);
  } catch {
    return;
  }
}
