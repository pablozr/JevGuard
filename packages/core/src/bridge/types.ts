import type { ParsedRule } from "../domain/types";

/** Command prefix for the internal review bridge; carries the schema version. */
export const REVIEW_BRIDGE_COMMAND_PREFIX = "jevguard.review.v1:";

/** Bridge schema version, present in both the prefix and the payload. */
export const REVIEW_BRIDGE_VERSION = 1;

/**
 * Hard bound on the serialized JSON payload, in UTF-8 bytes, before base64url. A
 * larger snapshot rejects emission; it is never truncated.
 */
export const REVIEW_BRIDGE_MAX_JSON_BYTES = 4096;

/**
 * Per-field string caps, in UTF-16 code units. Identifiers stay short so the
 * derived `evaluationId` (message + rule) fits its own cap; rule text is bounded
 * generously enough for hand-written policy. The serialized byte limit is the hard
 * backstop, so a payload of many maximal fields still rejects as oversized.
 */
export const REVIEW_BRIDGE_STRING_LIMITS = {
  evaluationId: 512,
  sessionID: 256,
  messageID: 256,
  ruleId: 128,
  ruleDescription: 1024,
  ruleViolation: 1024,
  ruleAllowed: 1024,
} as const;

/**
 * Rule snapshot carried across the bridge. `allowed` is always a string: the empty
 * string preserves the semantic absence of the rule's `Allowed` section, because
 * the user contract types the field as a string.
 */
export interface BridgeRuleSnapshot {
  readonly id: string;
  readonly description: string;
  readonly violation: string;
  readonly allowed: string;
}

/** Exact bridge payload encoded into the command string. */
export interface ReviewBridgePayload {
  readonly version: 1;
  readonly evaluationId: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly rule: BridgeRuleSnapshot;
  readonly probability: number;
}

/**
 * Exact own keys of a v1 payload root. The contract is strict: a payload carrying
 * any additional property (for example `task` or `diff`) is malformed, not ignored.
 */
export const REVIEW_BRIDGE_PAYLOAD_KEYS = [
  "version",
  "evaluationId",
  "sessionID",
  "messageID",
  "rule",
  "probability",
] as const;

/** Exact own keys of the v1 rule snapshot; any additional property is malformed. */
export const REVIEW_BRIDGE_RULE_KEYS = ["id", "description", "violation", "allowed"] as const;

/** Input to encode one bridge command from the exact rule that produced a local `FAIL`. */
export interface ReviewBridgeInput {
  readonly sessionID: string;
  readonly messageID: string;
  readonly rule: ParsedRule;
  readonly probability: number;
}

export type ReviewBridgeRejectionReason =
  | "INVALID_IDENTIFIER"
  | "INVALID_RULE_SNAPSHOT"
  | "INVALID_PROBABILITY"
  | "OVERSIZED_PAYLOAD";

/** Encoded command or the deterministic reason emission was refused. */
export type ReviewBridgeEncodeResult =
  | { readonly status: "ENCODED"; readonly command: string }
  | { readonly status: "REJECTED"; readonly reason: ReviewBridgeRejectionReason };
