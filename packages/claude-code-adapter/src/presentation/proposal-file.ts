import type { ProposalDelivery, ProposalRequestFile } from "./types";

/** A Claude alias or model id: no `/`, no space. Accepts `sonnet`, `claude-opus-5-5[1m]`, `a:b`. */
export const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,127}$/;

/** How long a request stays valid after it is created: the worker sets it, the mod enforces it. */
export const PROPOSAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

export const PROPOSAL_MAX_SYSTEM_LENGTH = 8_192;
export const PROPOSAL_MAX_PROMPT_LENGTH = 524_288;

const REQUEST_KEYS = [
  "v",
  "kind",
  "turnId",
  "createdAt",
  "expiresAt",
  "delivery",
  "model",
  "system",
  "prompt",
];

type JsonRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: JsonRecord): boolean {
  const keys = Object.keys(record);

  return keys.length === REQUEST_KEYS.length && REQUEST_KEYS.every((key) => keys.includes(key));
}

function isDelivery(value: unknown): value is ProposalDelivery {
  return value === "user" || value === "agent";
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value !== "" && value.length <= max;
}

function isModel(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && CLAUDE_MODEL_PATTERN.test(value));
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requestOf(record: JsonRecord): ProposalRequestFile | null {
  const { turnId, createdAt, expiresAt, delivery, model, system, prompt } = record;

  if (typeof turnId !== "string" || !isDate(createdAt) || !isDate(expiresAt)) return null;
  if (!isDelivery(delivery) || !isModel(model)) return null;
  if (!isBoundedText(system, PROPOSAL_MAX_SYSTEM_LENGTH)) return null;
  if (!isBoundedText(prompt, PROPOSAL_MAX_PROMPT_LENGTH)) return null;

  return {
    v: 1,
    kind: "PROPOSAL_REQUEST",
    turnId,
    createdAt,
    expiresAt,
    delivery,
    model,
    system,
    prompt,
  };
}

/**
 * Parses a request file strictly. `null` when it is not exactly the expected shape, names
 * another unit, was created in the future, lives longer than the request TTL or is expired:
 * a request is valid only while `nowMs` is before `expiresAt`.
 */
export function parseProposalRequestFile(
  text: string,
  expected: { readonly turnId: string },
  nowMs: number,
): ProposalRequestFile | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(value) || !hasExactKeys(value)) return null;
  if (value.v !== 1 || value.kind !== "PROPOSAL_REQUEST") return null;

  const request = requestOf(value);

  if (request === null || request.turnId !== expected.turnId) return null;

  const createdMs = Date.parse(request.createdAt);
  const expiresMs = Date.parse(request.expiresAt);

  if (createdMs > nowMs || expiresMs - createdMs > PROPOSAL_REQUEST_TTL_MS) return null;

  return nowMs < expiresMs ? request : null;
}
