import {
  type BridgeRuleSnapshot,
  REVIEW_BRIDGE_COMMAND_PREFIX,
  REVIEW_BRIDGE_MAX_JSON_BYTES,
  REVIEW_BRIDGE_PAYLOAD_KEYS,
  REVIEW_BRIDGE_RULE_KEYS,
  REVIEW_BRIDGE_STRING_LIMITS,
  REVIEW_BRIDGE_VERSION,
  type ReviewBridgePayload,
} from "@jevguard/core";

export type BridgeDecodeRejection =
  | "NOT_BRIDGE_COMMAND"
  | "MALFORMED_ENCODING"
  | "OVERSIZED_PAYLOAD"
  | "MALFORMED_PAYLOAD"
  | "UNSUPPORTED_VERSION";

export type BridgeDecodeResult =
  | { readonly status: "DECODED"; readonly payload: ReviewBridgePayload }
  | { readonly status: "REJECTED"; readonly reason: BridgeDecodeRejection };

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_ENCODED_LENGTH = Math.ceil(REVIEW_BRIDGE_MAX_JSON_BYTES / 3) * 4;

/**
 * Reads the command string from a `tui.command.execute` event. Any other event
 * type or a malformed shape yields `null`, so the handler never throws on an
 * unexpected host payload.
 */
export function readCommandText(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "tui.command.execute") {
    return null;
  }

  const properties = event.properties;

  if (!isRecord(properties)) {
    return null;
  }

  const command = properties.command;

  return typeof command === "string" ? command : null;
}

/**
 * Consumer-side validation of the internal review bridge command. Base64url is only
 * an encoding: the prefix, alphabet, bounds, schema version, field caps, derived
 * evaluation identity, and JSON shape are all re-checked, so a malformed,
 * non-JevGuard, oversized, or mismatched command is rejected without throwing.
 */
export function decodeBridgeCommand(command: unknown): BridgeDecodeResult {
  if (typeof command !== "string" || !command.startsWith(REVIEW_BRIDGE_COMMAND_PREFIX)) {
    return reject("NOT_BRIDGE_COMMAND");
  }

  const encoded = command.slice(REVIEW_BRIDGE_COMMAND_PREFIX.length);

  if (encoded.length === 0) {
    return reject("MALFORMED_ENCODING");
  }

  if (encoded.length > MAX_ENCODED_LENGTH) {
    return reject("OVERSIZED_PAYLOAD");
  }

  const json = decodeBase64Url(encoded);

  if (json === null) {
    return reject("MALFORMED_ENCODING");
  }

  if (utf8ByteLength(json) > REVIEW_BRIDGE_MAX_JSON_BYTES) {
    return reject("OVERSIZED_PAYLOAD");
  }

  const parsed = parseJson(json);

  if (parsed === null) {
    return reject("MALFORMED_PAYLOAD");
  }

  return validatePayload(parsed);
}

function decodeBase64Url(encoded: string): string | null {
  if (!BASE64URL_PATTERN.test(encoded) || encoded.length % 4 === 1) {
    return null;
  }

  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function validatePayload(value: unknown): BridgeDecodeResult {
  if (!isRecord(value)) {
    return reject("MALFORMED_PAYLOAD");
  }

  if (value.version !== REVIEW_BRIDGE_VERSION) {
    return reject("UNSUPPORTED_VERSION");
  }

  if (!hasOnlyKeys(value, REVIEW_BRIDGE_PAYLOAD_KEYS)) {
    return reject("MALFORMED_PAYLOAD");
  }

  if (!isIdentifier(value.evaluationId, REVIEW_BRIDGE_STRING_LIMITS.evaluationId)) {
    return reject("MALFORMED_PAYLOAD");
  }

  if (!isIdentifier(value.sessionID, REVIEW_BRIDGE_STRING_LIMITS.sessionID)) {
    return reject("MALFORMED_PAYLOAD");
  }

  if (!isIdentifier(value.messageID, REVIEW_BRIDGE_STRING_LIMITS.messageID)) {
    return reject("MALFORMED_PAYLOAD");
  }

  if (!isProbability(value.probability)) {
    return reject("MALFORMED_PAYLOAD");
  }

  const rule = readRuleSnapshot(value.rule);

  if (rule === null) {
    return reject("MALFORMED_PAYLOAD");
  }

  if (value.evaluationId !== `${value.messageID}:${rule.id}`) {
    return reject("MALFORMED_PAYLOAD");
  }

  return {
    status: "DECODED",
    payload: {
      version: REVIEW_BRIDGE_VERSION,
      evaluationId: value.evaluationId,
      sessionID: value.sessionID,
      messageID: value.messageID,
      rule,
      probability: value.probability,
    },
  };
}

function readRuleSnapshot(value: unknown): BridgeRuleSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, REVIEW_BRIDGE_RULE_KEYS)) {
    return null;
  }

  if (
    !isIdentifier(value.id, REVIEW_BRIDGE_STRING_LIMITS.ruleId) ||
    !isIdentifier(value.description, REVIEW_BRIDGE_STRING_LIMITS.ruleDescription) ||
    !isIdentifier(value.violation, REVIEW_BRIDGE_STRING_LIMITS.ruleViolation) ||
    !isBoundedString(value.allowed, REVIEW_BRIDGE_STRING_LIMITS.ruleAllowed)
  ) {
    return null;
  }

  return {
    id: value.id,
    description: value.description,
    violation: value.violation,
    allowed: value.allowed,
  };
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reject(reason: BridgeDecodeRejection): BridgeDecodeResult {
  return { status: "REJECTED", reason };
}
