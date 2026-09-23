import type { ParsedRule } from "../domain/types";
import { encodeBase64Url, utf8ByteLength } from "./base64url";
import {
  type BridgeRuleSnapshot,
  REVIEW_BRIDGE_COMMAND_PREFIX,
  REVIEW_BRIDGE_MAX_JSON_BYTES,
  REVIEW_BRIDGE_PAYLOAD_KEYS,
  REVIEW_BRIDGE_RULE_KEYS,
  REVIEW_BRIDGE_STRING_LIMITS,
  REVIEW_BRIDGE_VERSION,
  type ReviewBridgeEncodeResult,
  type ReviewBridgeInput,
  type ReviewBridgePayload,
  type ReviewBridgeRejectionReason,
} from "./types";

/**
 * Encodes the review bridge command for one local `error` rule that reached `FAIL`.
 * The exact rule used for the judgment is snapshotted, `allowed` absence becomes the
 * empty string, and the payload is validated and bounded before serialization; any
 * invalid or oversized snapshot returns `REJECTED` and never produces a command.
 */
export function encodeReviewBridge(input: ReviewBridgeInput): ReviewBridgeEncodeResult {
  const payload = buildPayload(input);
  const rejection = validatePayload(payload);

  if (rejection !== null) {
    return { status: "REJECTED", reason: rejection };
  }

  const json = JSON.stringify(payload);

  if (utf8ByteLength(json) > REVIEW_BRIDGE_MAX_JSON_BYTES) {
    return { status: "REJECTED", reason: "OVERSIZED_PAYLOAD" };
  }

  return {
    status: "ENCODED",
    command: `${REVIEW_BRIDGE_COMMAND_PREFIX}${encodeBase64Url(json)}`,
  };
}

/**
 * Deterministic evaluation identity for the judged turn and rule. It is stable
 * across retries of the same deduplicated turn and fits the identifier cap because
 * the message and rule caps sum below it.
 */
function buildPayload(input: ReviewBridgeInput): ReviewBridgePayload {
  return {
    version: REVIEW_BRIDGE_VERSION,
    evaluationId: `${input.messageID}:${input.rule.id}`,
    sessionID: input.sessionID,
    messageID: input.messageID,
    rule: toRuleSnapshot(input.rule),
    probability: input.probability,
  };
}

function toRuleSnapshot(rule: ParsedRule): BridgeRuleSnapshot {
  return {
    id: rule.id,
    description: rule.description,
    violation: rule.violation,
    allowed: rule.allowed ?? "",
  };
}

function validatePayload(payload: ReviewBridgePayload): ReviewBridgeRejectionReason | null {
  if (payload.version !== REVIEW_BRIDGE_VERSION) {
    return "INVALID_IDENTIFIER";
  }

  if (!hasOnlyKeys(payload, REVIEW_BRIDGE_PAYLOAD_KEYS)) {
    return "INVALID_IDENTIFIER";
  }

  if (!isIdentifier(payload.evaluationId, REVIEW_BRIDGE_STRING_LIMITS.evaluationId)) {
    return "INVALID_IDENTIFIER";
  }

  if (!isIdentifier(payload.sessionID, REVIEW_BRIDGE_STRING_LIMITS.sessionID)) {
    return "INVALID_IDENTIFIER";
  }

  if (!isIdentifier(payload.messageID, REVIEW_BRIDGE_STRING_LIMITS.messageID)) {
    return "INVALID_IDENTIFIER";
  }

  if (!isProbability(payload.probability)) {
    return "INVALID_PROBABILITY";
  }

  if (!isRuleSnapshot(payload.rule)) {
    return "INVALID_RULE_SNAPSHOT";
  }

  return null;
}

function isIdentifier(value: unknown, limit: number): value is string {
  return isBoundedString(value, limit) && value.length > 0;
}

function isBoundedString(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRuleSnapshot(value: unknown): value is BridgeRuleSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    hasOnlyKeys(value, REVIEW_BRIDGE_RULE_KEYS) &&
    isIdentifier(value.id, REVIEW_BRIDGE_STRING_LIMITS.ruleId) &&
    isIdentifier(value.description, REVIEW_BRIDGE_STRING_LIMITS.ruleDescription) &&
    isIdentifier(value.violation, REVIEW_BRIDGE_STRING_LIMITS.ruleViolation) &&
    isBoundedString(value.allowed, REVIEW_BRIDGE_STRING_LIMITS.ruleAllowed)
  );
}

function hasOnlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
