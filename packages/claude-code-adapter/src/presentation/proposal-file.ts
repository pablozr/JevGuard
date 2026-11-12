import {
  DELIVERY_MAX_FINDING_PATH_LENGTH,
  DELIVERY_MAX_FINDING_TEXT_LENGTH,
  DELIVERY_MAX_FINDINGS,
  type DeliveryFinding,
  FINDING_ID_PATTERN,
  type FindingLocation,
  isProbability,
  MAX_FINDING_LOCATIONS,
} from "@jevguard/core";
import { hasKeys, isCount, isRecord, type JsonRecord } from "./json-record";
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
  "fromDelivery",
  "model",
  "system",
  "prompt",
  "findings",
  "omitted",
];

const FINDING_KEYS = [
  "id",
  "kind",
  "description",
  "severity",
  "probability",
  "violation",
  "allowed",
  "locations",
];
const LOCATION_KEYS = ["path", "hunk"];
const HUNK_KEYS = ["ordinal", "newStart", "newLines"];

function isFindingText(value: unknown): value is string {
  return typeof value === "string" && value.length <= DELIVERY_MAX_FINDING_TEXT_LENGTH;
}

function hunkOf(value: unknown): FindingLocation["hunk"] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasKeys(value, HUNK_KEYS)) return undefined;

  const { ordinal, newStart, newLines } = value;

  return isCount(ordinal) && isCount(newStart) && isCount(newLines)
    ? { ordinal, newStart, newLines }
    : undefined;
}

function locationOf(value: unknown): FindingLocation | null {
  if (!isRecord(value) || !hasKeys(value, LOCATION_KEYS)) return null;

  const { path } = value;
  const hunk = hunkOf(value.hunk);

  if (typeof path !== "string" || path.length > DELIVERY_MAX_FINDING_PATH_LENGTH) return null;

  return hunk === undefined ? null : { path, hunk };
}

function locationsOf(value: unknown): readonly FindingLocation[] | null {
  if (!Array.isArray(value) || value.length > MAX_FINDING_LOCATIONS) return null;

  const parsed = value.map(locationOf);

  return parsed.every((location) => location !== null) ? parsed : null;
}

function findingOf(value: unknown): DeliveryFinding | null {
  if (!isRecord(value) || !hasKeys(value, FINDING_KEYS)) return null;

  const { id, kind, description, severity, probability, violation, allowed } = value;
  const locations = locationsOf(value.locations);

  if (typeof id !== "string" || !FINDING_ID_PATTERN.test(id)) return null;
  if (kind !== "RULE" && kind !== "BUILT_IN") return null;
  if (severity !== "error" && severity !== "warning") return null;
  if (!isProbability(probability)) return null;
  if (!isFindingText(description) || !isFindingText(violation) || !isFindingText(allowed)) {
    return null;
  }

  return locations === null
    ? null
    : { id, kind, description, severity, probability, violation, allowed, locations };
}

function findingsOf(value: unknown): readonly DeliveryFinding[] | null {
  if (!Array.isArray(value) || value.length > DELIVERY_MAX_FINDINGS) return null;

  const parsed = value.map(findingOf);

  return parsed.every((finding) => finding !== null) ? parsed : null;
}

function isDelivery(value: unknown): value is ProposalDelivery {
  return value === "user" || value === "agent";
}

function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value !== "" && value.length <= max;
}

function isOptionalBoundedText(value: unknown, max: number): value is string | null {
  return value === null || isBoundedText(value, max);
}

function isModel(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && CLAUDE_MODEL_PATTERN.test(value));
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function requestOf(record: JsonRecord): ProposalRequestFile | null {
  const { turnId, createdAt, expiresAt, delivery, fromDelivery, model, system, prompt, omitted } =
    record;

  if (typeof turnId !== "string" || !isDate(createdAt) || !isDate(expiresAt)) return null;
  if (!isDelivery(delivery) || typeof fromDelivery !== "boolean" || !isModel(model)) return null;
  if (!isOptionalBoundedText(system, PROPOSAL_MAX_SYSTEM_LENGTH)) return null;
  if (!isOptionalBoundedText(prompt, PROPOSAL_MAX_PROMPT_LENGTH)) return null;
  if ((system === null) !== (prompt === null) || !isCount(omitted)) return null;

  const findings = findingsOf(record.findings);

  if (findings === null || (delivery === "agent" && findings.length === 0)) return null;

  return {
    v: 2,
    kind: "PROPOSAL_REQUEST",
    turnId,
    createdAt,
    expiresAt,
    delivery,
    fromDelivery,
    model,
    system,
    prompt,
    findings,
    omitted,
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

  if (!isRecord(value) || !hasKeys(value, REQUEST_KEYS)) return null;
  if (value.v !== 2 || value.kind !== "PROPOSAL_REQUEST") return null;

  const request = requestOf(value);

  if (request === null || request.turnId !== expected.turnId) return null;

  const createdMs = Date.parse(request.createdAt);
  const expiresMs = Date.parse(request.expiresAt);

  if (createdMs > nowMs || expiresMs - createdMs > PROPOSAL_REQUEST_TTL_MS) return null;

  return nowMs < expiresMs ? request : null;
}
