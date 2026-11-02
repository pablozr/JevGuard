import type { RuleSeverity } from "../domain/types";

/**
 * Name of the internal OpenCode subagent that drafts a remediation proposal. It is
 * registered by the plugin `config` hook as a tool-denied subagent, so it cannot
 * execute a tool, edit a file, or produce a patch.
 */
export const PROPOSER_AGENT_NAME = "jevguard-proposer";

/**
 * Upper bound on the task text carried in an automatic proposal request. A longer
 * task rejects the request instead of truncating the evidence the proposer receives.
 */
export const REMEDIATION_MAX_TASK_LENGTH = 16_384;

/** `observe` never messages the agent; `remediate` is the user's opt-in to a bounded fix chain. */
export type RemediationMode = "observe" | "remediate";

export const MAX_ATTEMPTS_DEFAULT = 2;
export const MAX_ATTEMPTS_CEILING = 3;

/** The unanchored shape of a chain id, for patterns that find one inside a longer text. */
export const CHAIN_ID_SOURCE = "[A-Za-z0-9._:-]{1,512}";
/** The shape of a chain id (the id of the turn that started it), wherever it is stored or parsed. */
export const CHAIN_ID_PATTERN = new RegExp(`^${CHAIN_ID_SOURCE}$`);
/** The shape of a rule id or built-in check id carried by a chain. */
export const FINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** True for an attempt count a chain can reach: an integer in 1..MAX_ATTEMPTS_CEILING. */
export function isAttemptCount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_ATTEMPTS_CEILING
  );
}

/** Remediation messages one session may send to its agent. */
export const MAX_AGENT_DELIVERIES_PER_SESSION = 3;

/** Longest proposer answer carried into a delivery or shown as a proposal; the rest is dropped. */
export const PROPOSAL_MAX_TEXT_LENGTH = 32_768;

/** True while a session has made fewer agent deliveries than the limit allows. */
export function withinSessionLimit(deliveredInSession: number): boolean {
  return deliveredInSession < MAX_AGENT_DELIVERIES_PER_SESSION;
}

/** MVP proposal trigger. `WARN` and every operational outcome never trigger. */
export type ProposalTrigger = "FAIL";

/**
 * Strict remediation policy. Absent configuration uses the defaults: auto-propose is
 * enabled for `FAIL` and no model is pinned, so the proposer inherits the host's
 * model. A `null` model always means "inherit the host model"; a present model must
 * be one `provider/model` specifier.
 */
export interface RemediationConfig {
  readonly autoPropose: boolean;
  readonly proposeOn: readonly ProposalTrigger[];
  readonly model: string | null;
}

export const DEFAULT_REMEDIATION_CONFIG: RemediationConfig = {
  autoPropose: true,
  proposeOn: ["FAIL"],
  model: null,
};

export type RemediationConfigResult =
  | { readonly status: "VALID"; readonly config: RemediationConfig }
  | { readonly status: "INVALID"; readonly reason: "INVALID_CONFIG" };

/** Exact rule text snapshotted from the parse that produced the failing judgment. */
export interface RemediationRuleSnapshot {
  readonly id: string;
  readonly description: string;
  readonly violation: string;
  readonly allowed: string;
}

/** One local `error` rule finding that reached `FAIL` in the evaluated turn. */
export interface RemediationRuleFinding {
  readonly ruleId: string;
  readonly severity: RuleSeverity;
  readonly rule: RemediationRuleSnapshot;
  readonly probability: number;
  readonly scopedPaths: readonly string[];
}

/** One built-in check finding that reached `FAIL` in the evaluated turn. */
export interface RemediationBuiltInFinding {
  readonly checkId: string;
  readonly severity: RuleSeverity;
  readonly probability: number;
  readonly scopedPaths: readonly string[];
}

/**
 * One bounded aggregate request for an evaluated turn: the complete, safe, full
 * attributed patch plus every `FAIL` finding. It is never built from a repository or
 * global diff, and never from partial, blocked, or oversized evidence.
 */
export interface RemediationProposalRequest {
  readonly evaluationId: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly model: string | null;
  readonly task: string;
  readonly paths: readonly string[];
  readonly diff: string;
  readonly ruleFindings: readonly RemediationRuleFinding[];
  readonly builtInFindings: readonly RemediationBuiltInFinding[];
}

/**
 * In-memory coordination for automatic proposals. `claim` admits at most one
 * proposal per evaluated turn; child-session registration excludes the plugin's own
 * proposer sessions from review so a proposal can never recurse.
 */
export interface RemediationProposalStore {
  claim(evaluationId: string): boolean;
  registerChildSession(sessionID: string): void;
  isChildSession(sessionID: string): boolean;
}
