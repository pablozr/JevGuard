import type { ChainState } from "./chain";
import { CHAIN_ID_PATTERN, FINDING_ID_PATTERN, isAttemptCount } from "./types";

/** The most origin findings one chain can carry; the hosts' delivery limit matches it. */
export const MAX_CHAIN_ORIGINS = 64;

const SIGNATURE = /^[0-9a-f]{16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * A state a chain could really have saved: one signature and one turn per attempt, at
 * least one distinct origin id, and a scope for exactly the origins. Anything else cannot
 * prove its origins were judged, so it is treated as lost.
 */
function hasCoherentShape(state: {
  readonly originIds: readonly string[];
  readonly signatures: readonly string[];
  readonly turnIds: readonly string[];
  readonly attempts: number;
  readonly scopes: Record<string, unknown>;
}): boolean {
  const { originIds, signatures, turnIds, attempts, scopes } = state;
  const scoped = Object.keys(scopes);

  return (
    originIds.length > 0 &&
    originIds.length <= MAX_CHAIN_ORIGINS &&
    new Set(originIds).size === originIds.length &&
    originIds.every((id) => FINDING_ID_PATTERN.test(id) && scoped.includes(id)) &&
    scoped.length === originIds.length &&
    signatures.length === attempts &&
    signatures.every((signature) => SIGNATURE.test(signature)) &&
    new Set(signatures).size === signatures.length &&
    turnIds.length === attempts &&
    new Set(turnIds).size === turnIds.length
  );
}

/** Strict read of a saved chain state (already JSON-parsed); anything malformed is `null`. */
export function parseChainState(value: unknown): ChainState | null {
  if (!isRecord(value) || !isRecord(value.scopes)) return null;

  const { chainId, originIds, signatures, turnIds, attempts, scopes } = value;

  if (typeof chainId !== "string" || !CHAIN_ID_PATTERN.test(chainId)) return null;
  if (!isAttemptCount(attempts)) return null;
  if (!isStringArray(originIds) || !isStringArray(signatures) || !isStringArray(turnIds)) {
    return null;
  }
  if (!Object.values(scopes).every(isStringArray)) return null;
  if (!hasCoherentShape({ originIds, signatures, turnIds, attempts, scopes })) return null;

  return {
    chainId,
    originIds,
    signatures,
    turnIds,
    attempts,
    scopes: scopes as ChainState["scopes"],
  };
}
