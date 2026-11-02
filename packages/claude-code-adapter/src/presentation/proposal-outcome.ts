import type { ChainStopCode } from "@jevguard/core";
import { hasKeys, isRecord } from "./json-record";
import type { ProposalFailureCode } from "./types";

/**
 * Why a chain's request ended without reaching the agent, as the mod reports it back to
 * the worker: a closed set that is also a `ChainStopCode`.
 */
export type ProposalOutcomeCode = Extract<
  ChainStopCode,
  "SESSION_LIMIT" | "DELIVERY_FAILED" | "SESSION_CHANGED" | "PROPOSAL_FAILED"
>;

const OUTCOME_CODES: readonly string[] = [
  "SESSION_LIMIT",
  "DELIVERY_FAILED",
  "SESSION_CHANGED",
  "PROPOSAL_FAILED",
];
const OUTCOME_KEYS = ["v", "kind", "turnId", "code"];

/**
 * The terminal result of one proposal request that belonged to a chain. The mod writes it
 * next to the request; the worker reads it once, ends the chain it names and deletes it.
 * Ids and a code only, never text.
 */
export interface ProposalOutcomeFile {
  readonly v: 1;
  readonly kind: "PROPOSAL_OUTCOME";
  readonly turnId: string;
  readonly code: ProposalOutcomeCode;
}

export function encodeProposalOutcome(turnId: string, code: ProposalOutcomeCode): string {
  return JSON.stringify({ v: 1, kind: "PROPOSAL_OUTCOME", turnId, code });
}

/** Strict parse: exactly the keys above and a known code, otherwise `null`. */
export function parseProposalOutcome(text: string): ProposalOutcomeFile | null {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }

  if (!isRecord(value) || !hasKeys(value, OUTCOME_KEYS)) return null;

  const { turnId, code } = value;

  if (value.v !== 1 || value.kind !== "PROPOSAL_OUTCOME") return null;
  if (typeof turnId !== "string" || typeof code !== "string" || !OUTCOME_CODES.includes(code)) {
    return null;
  }

  return { v: 1, kind: "PROPOSAL_OUTCOME", turnId, code: code as ProposalOutcomeCode };
}

/** A failed proposal (unreadable or invalid request, model error) ends its chain the same way. */
export function outcomeOfFailure(code: ProposalFailureCode): ProposalOutcomeCode {
  return code === "DELIVERY_FAILED" ? "DELIVERY_FAILED" : "PROPOSAL_FAILED";
}
