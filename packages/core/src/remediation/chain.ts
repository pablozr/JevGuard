import type { ReviewResult } from "../domain/types";
import type { RemediationMode, RemediationProposalRequest } from "./types";
import { MAX_ATTEMPTS_CEILING } from "./types";

/** Why a remediation chain ended without resolving every finding; a closed set. */
export type ChainStopCode =
  | "LIMIT"
  | "REPEATED_FAILURE"
  | "REGRESSION_INTRODUCED"
  | "UNVERIFIED"
  | "SESSION_LIMIT"
  | "DELIVERY_FAILED"
  | "SESSION_CHANGED"
  | "PROPOSAL_FAILED"
  | "EXPIRED";

/** What a delivered turn's task says about the chain it belongs to; see `parseAutoDelivery`. */
export type AutoDelivery =
  | { readonly attempt: number; readonly maxAttempts: number; readonly chainId: string }
  | "LEGACY"
  | null;

/**
 * State kept between the turns of one chain. `scopes` holds, per finding of the chain,
 * the paths its last judgment covered, so a later turn that narrowed a scope is caught.
 */
export interface ChainState {
  readonly chainId: string;
  readonly originIds: readonly string[];
  readonly signatures: readonly string[];
  readonly turnIds: readonly string[];
  readonly attempts: number;
  readonly scopes: Readonly<Record<string, readonly string[]>>;
}

/**
 * The ids behind an ended chain. `resolvedIds` holds only origin findings re-judged `PASS`
 * on their whole scope; every other origin (still failing, `WARN`, unavailable, skipped or
 * absent) stays in `remainingIds`, so missing evidence is never counted as a fix.
 */
export interface ChainOutcomeIds {
  readonly resolvedIds: readonly string[];
  readonly remainingIds: readonly string[];
}

export type ChainStep =
  | { readonly kind: "NONE" }
  | {
      readonly kind: "DELIVER";
      readonly chainId: string;
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly signature: string;
      readonly state: ChainState;
    }
  | {
      readonly kind: "STOP";
      readonly code: ChainStopCode;
      readonly maxAttempts: number;
      readonly state: ChainState;
      readonly ids: ChainOutcomeIds;
    }
  | {
      readonly kind: "RESOLVED";
      readonly maxAttempts: number;
      readonly state: ChainState;
      readonly ids: ChainOutcomeIds;
    };

export interface ChainFailure {
  readonly id: string;
  readonly scopedPaths: readonly string[];
}

export interface ChainStepInput {
  readonly mode: RemediationMode;
  readonly maxAttempts: number;
  /** From the reviewed turn's task. */
  readonly delivery: AutoDelivery;
  /** The saved state of `delivery.chainId`, if any. */
  readonly chain: ChainState | null;
  /** The core's proposal request for this turn; `null` when evidence is not complete and safe. */
  readonly request: RemediationProposalRequest | null;
  readonly results: readonly ReviewResult[];
  readonly turnId: string;
}

const FNV_PRIME = 0x01000193;
const FNV_OFFSETS = [0x811c9dc5, 0x050c5d1f];

function fnv1a(text: string, offset: number): string {
  let hash = offset;

  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), FNV_PRIME) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

function hashOf(text: string): string {
  return FNV_OFFSETS.map((offset) => fnv1a(text, offset)).join("");
}

function idOf(result: ReviewResult): string | null {
  if (result.kind === "RULE") return result.ruleId;

  return result.kind === "BUILT_IN" ? result.checkId : null;
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

/** Every finding that can start or continue a chain: a `FAIL` of an `error` rule or a built-in check. */
export function chainFailuresOf(results: readonly ReviewResult[]): readonly ChainFailure[] {
  const failures: ChainFailure[] = [];

  for (const result of results) {
    if (result.outcome !== "FAIL") continue;
    if (result.kind === "RULE" && result.severity !== "error") continue;

    const id = idOf(result);

    if (id !== null) failures.push({ id, scopedPaths: [...result.scopedPaths] });
  }

  return failures;
}

/**
 * Order- and duplicate-insensitive identity of a set of failures: the same findings over
 * the same paths always give the same signature, whatever order they arrive in.
 */
export function failureSignature(failures: readonly ChainFailure[]): string {
  const parts = failures.map(
    (failure) => `${failure.id}:${sortedUnique(failure.scopedPaths).join(",")}`,
  );

  return hashOf(sortedUnique(parts).join("|"));
}

function scopesOf(
  results: readonly ReviewResult[],
  ids: readonly string[],
): Readonly<Record<string, readonly string[]>> {
  const scopes: Record<string, readonly string[]> = {};

  for (const result of results) {
    const id = idOf(result);

    if (id !== null && ids.includes(id)) scopes[id] = sortedUnique(result.scopedPaths);
  }

  return scopes;
}

/** `PASS` and `FAIL` are verdicts on a finding; a `WARN` neither clears nor fails it. */
function isJudged(result: ReviewResult): boolean {
  return result.outcome === "PASS" || result.outcome === "FAIL";
}

function narrowed(before: readonly string[] | undefined, after: readonly string[]): boolean {
  return before?.some((path) => !after.includes(path)) === true;
}

function judgedOf(id: string, results: readonly ReviewResult[]): readonly ReviewResult[] {
  return results.filter((result) => idOf(result) === id && isJudged(result));
}

/** An origin finding is unverifiable when it was not judged this turn or its scope shrank. */
function hasUnverifiedOrigin(state: ChainState, results: readonly ReviewResult[]): boolean {
  return state.originIds.some((id) => {
    const judged = judgedOf(id, results);

    return (
      judged.length === 0 ||
      judged.some((result) => narrowed(state.scopes[id], sortedUnique(result.scopedPaths)))
    );
  });
}

export function chainIdsOf(state: ChainState, results: readonly ReviewResult[]): ChainOutcomeIds {
  const resolvedIds = state.originIds.filter((id) => {
    const judged = judgedOf(id, results);

    return (
      judged.length > 0 &&
      judged.every(
        (result) =>
          result.outcome === "PASS" &&
          !narrowed(state.scopes[id], sortedUnique(result.scopedPaths)),
      )
    );
  });

  return { resolvedIds, remainingIds: state.originIds.filter((id) => !resolvedIds.includes(id)) };
}

/** The ids of a chain that ended without a re-judgment: nothing counts as fixed. */
export function unresolvedIds(state: ChainState): ChainOutcomeIds {
  return { resolvedIds: [], remainingIds: [...state.originIds] };
}

function stop(
  code: ChainStopCode,
  input: ChainStepInput,
  state: ChainState,
  ids: ChainOutcomeIds = chainIdsOf(state, input.results),
): ChainStep {
  return { kind: "STOP", code, maxAttempts: input.maxAttempts, state, ids };
}

function startOf(input: ChainStepInput, failures: readonly ChainFailure[]): ChainStep {
  if (input.request === null || failures.length === 0) return { kind: "NONE" };

  const signature = failureSignature(failures);
  const originIds = sortedUnique(failures.map((failure) => failure.id));

  return {
    kind: "DELIVER",
    chainId: input.turnId,
    attempt: 1,
    maxAttempts: input.maxAttempts,
    signature,
    state: {
      chainId: input.turnId,
      originIds,
      signatures: [signature],
      turnIds: [input.turnId],
      attempts: 1,
      scopes: scopesOf(input.results, originIds),
    },
  };
}

function continuation(
  input: ChainStepInput,
  state: ChainState,
  failures: readonly ChainFailure[],
): ChainStep {
  if (hasUnverifiedOrigin(state, input.results)) return stop("UNVERIFIED", input, state);

  if (failures.length === 0) {
    return {
      kind: "RESOLVED",
      maxAttempts: input.maxAttempts,
      state,
      ids: chainIdsOf(state, input.results),
    };
  }

  if (input.request === null) return stop("UNVERIFIED", input, state);

  if (failures.some((failure) => !state.originIds.includes(failure.id))) {
    return stop("REGRESSION_INTRODUCED", input, state);
  }

  const signature = failureSignature(failures);

  if (state.signatures.includes(signature)) return stop("REPEATED_FAILURE", input, state);
  if (state.attempts >= input.maxAttempts) return stop("LIMIT", input, state);

  const attempt = state.attempts + 1;

  return {
    kind: "DELIVER",
    chainId: state.chainId,
    attempt,
    maxAttempts: input.maxAttempts,
    signature,
    state: {
      ...state,
      signatures: [...state.signatures, signature],
      turnIds: [...state.turnIds, input.turnId],
      attempts: attempt,
      scopes: { ...state.scopes, ...scopesOf(input.results, state.originIds) },
    },
  };
}

function unverifiedWithoutState(
  input: ChainStepInput,
  delivery: Exclude<AutoDelivery, "LEGACY" | null>,
  known: ChainState | null,
): ChainStep {
  const state: ChainState = known ?? {
    chainId: delivery.chainId,
    originIds: [],
    signatures: [],
    turnIds: [],
    attempts: Math.min(Math.max(delivery.attempt, 1), MAX_ATTEMPTS_CEILING),
    scopes: {},
  };

  return stop("UNVERIFIED", input, state, unresolvedIds(state));
}

/**
 * Decides, after one reviewed turn, whether the agent gets another remediation message.
 * Pure: the same input always gives the same step. `observe` and legacy marks never
 * deliver; a chain stops on a repeated failure, a new failure, an unverifiable finding
 * or the attempt limit. Warnings and operational outcomes never start a chain.
 */
export function decideChainStep(input: ChainStepInput): ChainStep {
  if (input.mode === "observe" || input.delivery === "LEGACY") return { kind: "NONE" };

  const failures = chainFailuresOf(input.results);
  const { delivery, chain } = input;

  if (delivery === null) return startOf(input, failures);

  if (chain === null || chain.chainId !== delivery.chainId || chain.attempts !== delivery.attempt) {
    return unverifiedWithoutState(input, delivery, chain);
  }

  return continuation(input, chain, failures);
}

/**
 * A unit that has no turn of its own (skipped or unavailable) cannot judge a chain, so a
 * saved chain it belongs to can only end as unverified; nothing counts as fixed.
 */
export function decideOrphanStep(
  state: ChainState,
  maxAttempts: number,
): Extract<ChainStep, { kind: "STOP" }> {
  return { kind: "STOP", code: "UNVERIFIED", maxAttempts, state, ids: unresolvedIds(state) };
}

/**
 * Takes back a `DELIVER` whose message could not be sent or whose state could not be saved.
 * A first attempt leaves nothing to end (`null`); a continuation ends as `DELIVERY_FAILED`
 * with the chain as it stood before the attempt and what it had resolved by then.
 */
export function abandonDeliver(
  step: Extract<ChainStep, { kind: "DELIVER" }>,
  results: readonly ReviewResult[],
): Extract<ChainStep, { kind: "STOP" }> | null {
  if (step.attempt <= 1) return null;

  const state: ChainState = {
    ...step.state,
    attempts: step.state.attempts - 1,
    signatures: step.state.signatures.slice(0, -1),
    turnIds: step.state.turnIds.slice(0, -1),
  };

  return {
    kind: "STOP",
    code: "DELIVERY_FAILED",
    maxAttempts: step.maxAttempts,
    state,
    ids: chainIdsOf(state, results),
  };
}
