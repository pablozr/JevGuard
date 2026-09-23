import { describe, expect, test } from "vitest";
import {
  encodeReviewBridge,
  type ParsedRule,
  REVIEW_BRIDGE_COMMAND_PREFIX,
  REVIEW_BRIDGE_MAX_JSON_BYTES,
  REVIEW_BRIDGE_PAYLOAD_KEYS,
  REVIEW_BRIDGE_RULE_KEYS,
  type ReviewBridgeEncodeResult,
} from "../src/index";

const SESSION_ID = "ses_1";
const MESSAGE_ID = "msg_assistant";

function parsedRule(overrides: Partial<ParsedRule> = {}): ParsedRule {
  return {
    id: "ARCH-001",
    severity: "error",
    scope: null,
    description: "Controllers must not hold domain logic.",
    violation: "A controller performs domain decisions directly.",
    allowed: null,
    ...overrides,
  };
}

function encoded(result: ReviewBridgeEncodeResult): string {
  if (result.status !== "ENCODED") {
    throw new Error(`expected an encoded command, got ${result.reason}`);
  }

  return result.command;
}

function decode(command: string): unknown {
  const encodedPayload = command.slice(REVIEW_BRIDGE_COMMAND_PREFIX.length);

  return JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
}

function bridgeInput(overrides: Partial<ParsedRule> = {}, probability = 0.82) {
  return { sessionID: SESSION_ID, messageID: MESSAGE_ID, rule: parsedRule(overrides), probability };
}

describe("encodeReviewBridge", () => {
  test("roundtrips the exact snapshot with an empty allowed for semantic absence", () => {
    const command = encoded(encodeReviewBridge(bridgeInput()));

    expect(command.startsWith(REVIEW_BRIDGE_COMMAND_PREFIX)).toBe(true);

    const encodedPayload = command.slice(REVIEW_BRIDGE_COMMAND_PREFIX.length);

    expect(encodedPayload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodedPayload).not.toMatch(/[+/=]/);
    expect(decode(command)).toEqual({
      version: 1,
      evaluationId: `${MESSAGE_ID}:ARCH-001`,
      sessionID: SESSION_ID,
      messageID: MESSAGE_ID,
      rule: {
        id: "ARCH-001",
        description: "Controllers must not hold domain logic.",
        violation: "A controller performs domain decisions directly.",
        allowed: "",
      },
      probability: 0.82,
    });
  });

  test("preserves an Allowed section and non-ASCII rule text through base64url", () => {
    const command = encoded(
      encodeReviewBridge(
        bridgeInput(
          {
            description: "Regla de dominio · sin lógica",
            violation: "El controlador decide 🙅",
            allowed: "La validación y el mapeo HTTP están permitidos.",
          },
          0.7,
        ),
      ),
    );

    expect(decode(command)).toMatchObject({
      rule: {
        allowed: "La validación y el mapeo HTTP están permitidos.",
        description: "Regla de dominio · sin lógica",
        violation: "El controlador decide 🙅",
      },
      probability: 0.7,
    });
  });

  test("derives a deterministic evaluation id from message and rule", () => {
    const first = encoded(encodeReviewBridge(bridgeInput()));
    const second = encoded(encodeReviewBridge(bridgeInput()));

    expect(first).toBe(second);
  });

  test("accepts the inclusive probability bounds", () => {
    expect(encodeReviewBridge(bridgeInput({}, 0)).status).toBe("ENCODED");
    expect(encodeReviewBridge(bridgeInput({}, 1)).status).toBe("ENCODED");
  });

  test.each([-0.0001, 1.0001, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the out-of-range probability %s",
    (probability) => {
      expect(encodeReviewBridge(bridgeInput({}, probability))).toEqual({
        status: "REJECTED",
        reason: "INVALID_PROBABILITY",
      });
    },
  );

  test("rejects a rule text field over its cap", () => {
    const result = encodeReviewBridge(bridgeInput({ violation: "v".repeat(1025) }));

    expect(result).toEqual({ status: "REJECTED", reason: "INVALID_RULE_SNAPSHOT" });
  });

  test("rejects an identifier over its cap", () => {
    const result = encodeReviewBridge({ ...bridgeInput(), sessionID: "s".repeat(257) });

    expect(result).toEqual({ status: "REJECTED", reason: "INVALID_IDENTIFIER" });
  });

  test("rejects an oversized serialized payload without truncating", () => {
    const result = encodeReviewBridge({
      sessionID: "s".repeat(256),
      messageID: "m".repeat(256),
      rule: parsedRule({
        id: "r".repeat(128),
        description: "d".repeat(1024),
        violation: "v".repeat(1024),
        allowed: "a".repeat(1024),
      }),
      probability: 0.9,
    });

    expect(result).toEqual({ status: "REJECTED", reason: "OVERSIZED_PAYLOAD" });
    expect("command" in result).toBe(false);
  });

  test("emits exactly the strict v1 payload and rule keys", () => {
    const payload = decode(encoded(encodeReviewBridge(bridgeInput()))) as Record<string, unknown>;
    const rule = payload.rule as Record<string, unknown>;

    expect(Object.keys(payload).sort()).toEqual([...REVIEW_BRIDGE_PAYLOAD_KEYS].sort());
    expect(Object.keys(rule).sort()).toEqual([...REVIEW_BRIDGE_RULE_KEYS].sort());
    expect(payload).not.toHaveProperty("task");
    expect(payload).not.toHaveProperty("diff");
  });

  test("keeps a maximal bounded payload under the byte limit", () => {
    const result = encodeReviewBridge({
      sessionID: "s".repeat(64),
      messageID: "m".repeat(64),
      rule: parsedRule({
        id: "R-1",
        description: "d".repeat(400),
        violation: "v".repeat(400),
        allowed: "a".repeat(400),
      }),
      probability: 0.5,
    });

    expect(result.status).toBe("ENCODED");
    expect(REVIEW_BRIDGE_MAX_JSON_BYTES).toBe(4096);
  });
});
