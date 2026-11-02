import {
  CHAIN_ID_PATTERN,
  FINDING_ID_PATTERN,
  isAttemptCount,
  MAX_CHAIN_ORIGINS,
} from "@jevguard/core";
import { hasKeys, isRecord, type JsonRecord } from "./json-record";
import type { DeliveryChain, ProposalDelivery, ProposalRequestFile } from "./types";

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

const CHAIN_KEYS = ["chainId", "attempt", "maxAttempts", "findings"];
const FINDING_KEYS = ["id", "severity", "probability", "paths", "violation", "allowed"];

/**
 * The limits of one chain request: the worker checks them before it writes and the mod
 * enforces them as it reads, so the producer can never emit what the consumer rejects.
 */
export const DELIVERY_MAX_FINDINGS = MAX_CHAIN_ORIGINS;
export const DELIVERY_MAX_FINDING_PATHS = 64;
export const DELIVERY_MAX_FINDING_PATH_LENGTH = 512;
export const DELIVERY_MAX_FINDING_TEXT_LENGTH = 2_000;

function isFindingText(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= DELIVERY_MAX_FINDING_TEXT_LENGTH)
  );
}

/** Whether a chain's findings fit the limits above; the findings are never truncated to fit. */
export function fitsDeliveryLimits(
  findings: readonly { readonly id: string; readonly paths: readonly string[] }[],
): boolean {
  return (
    findings.length > 0 &&
    findings.length <= DELIVERY_MAX_FINDINGS &&
    findings.every(
      (finding) =>
        FINDING_ID_PATTERN.test(finding.id) &&
        finding.paths.length <= DELIVERY_MAX_FINDING_PATHS &&
        finding.paths.every((path) => path.length <= DELIVERY_MAX_FINDING_PATH_LENGTH),
    )
  );
}

function findingOf(value: unknown): DeliveryChain["findings"][number] | null {
  if (!isRecord(value) || !hasKeys(value, FINDING_KEYS)) return null;

  const { id, severity, probability, paths, violation, allowed } = value;

  if (typeof id !== "string" || !FINDING_ID_PATTERN.test(id)) return null;
  if (severity !== "error" && severity !== "warning") return null;
  if (typeof probability !== "number" || probability < 0 || probability > 1) return null;
  if (!Array.isArray(paths) || paths.length > DELIVERY_MAX_FINDING_PATHS) return null;
  if (
    !paths.every(
      (path) => typeof path === "string" && path.length <= DELIVERY_MAX_FINDING_PATH_LENGTH,
    )
  ) {
    return null;
  }
  if (!isFindingText(violation) || !isFindingText(allowed)) return null;

  return { id, severity, probability, paths: [...paths], violation, allowed };
}

function chainOf(value: unknown): DeliveryChain | null {
  if (!isRecord(value) || !hasKeys(value, CHAIN_KEYS)) return null;

  const { chainId, attempt, maxAttempts, findings } = value;

  if (typeof chainId !== "string" || !CHAIN_ID_PATTERN.test(chainId)) return null;
  if (!isAttemptCount(attempt) || !isAttemptCount(maxAttempts) || attempt > maxAttempts)
    return null;
  if (
    !Array.isArray(findings) ||
    findings.length === 0 ||
    findings.length > DELIVERY_MAX_FINDINGS
  ) {
    return null;
  }

  const parsed = findings.map(findingOf);

  return parsed.every((finding) => finding !== null)
    ? { chainId, attempt, maxAttempts, findings: parsed }
    : null;
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
  const { turnId, createdAt, expiresAt, delivery, model, system, prompt, chain } = record;

  if (typeof turnId !== "string" || !isDate(createdAt) || !isDate(expiresAt)) return null;
  if (!isDelivery(delivery) || !isModel(model)) return null;
  if (!isBoundedText(system, PROPOSAL_MAX_SYSTEM_LENGTH)) return null;
  if (!isBoundedText(prompt, PROPOSAL_MAX_PROMPT_LENGTH)) return null;

  const parsedChain = chain === undefined ? undefined : chainOf(chain);

  if (parsedChain === null || (parsedChain !== undefined && delivery !== "agent")) return null;

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
    ...(parsedChain === undefined ? {} : { chain: parsedChain }),
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

  if (!isRecord(value) || !hasKeys(value, REQUEST_KEYS, ["chain"])) return null;
  if (value.v !== 1 || value.kind !== "PROPOSAL_REQUEST") return null;

  const request = requestOf(value);

  if (request === null || request.turnId !== expected.turnId) return null;

  const createdMs = Date.parse(request.createdAt);
  const expiresMs = Date.parse(request.expiresAt);

  if (createdMs > nowMs || expiresMs - createdMs > PROPOSAL_REQUEST_TTL_MS) return null;

  return nowMs < expiresMs ? request : null;
}
