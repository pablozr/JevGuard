import type { RuleSeverity } from "../domain/types";

/**
 * Upper bound on the task text carried in an automatic proposal request. A longer
 * task rejects the request instead of truncating the evidence the proposer receives.
 */
export const REMEDIATION_MAX_TASK_LENGTH = 16_384;

/** The shape of a rule id or built-in check id carried by a delivery. */
export const FINDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Remediation messages one session may send to its agent. */
export const MAX_AGENT_DELIVERIES_PER_SESSION = 3;

/** Longest proposer answer carried into a delivery or shown as a proposal; the rest is dropped. */
export const PROPOSAL_MAX_TEXT_LENGTH = 32_768;

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

/** Most locations one finding carries into a request or delivery. */
export const MAX_FINDING_LOCATIONS = 64;

/** Most findings one delivery lists; the rest are only counted. */
export const DELIVERY_MAX_FINDINGS = 32;

/** Longest path a delivery finding location carries. */
export const DELIVERY_MAX_FINDING_PATH_LENGTH = 512;

/** Longest text (description, violation, allowed, location, id) a delivery finding line carries. */
export const DELIVERY_MAX_FINDING_TEXT_LENGTH = 1_000;

/** Where a finding failed: a file, plus the unified-diff hunk when the evidence was sliced by hunk. */
export interface FindingLocation {
  readonly path: string;
  readonly hunk: {
    readonly ordinal: number;
    readonly newStart: number;
    readonly newLines: number;
  } | null;
}

/**
 * What a host does with a unit that has a `FAIL`: `DELIVER` sends the agent one
 * message, `PANEL` only shows the proposal to the user, and `SESSION_LIMIT` means the
 * session already received the most deliveries it may.
 */
export type AgentDeliveryDecision = "DELIVER" | "PANEL" | "SESSION_LIMIT";

/** One local `error` rule finding that reached `FAIL` in the evaluated turn. */
export interface RemediationRuleFinding {
  readonly ruleId: string;
  readonly severity: RuleSeverity;
  readonly rule: RemediationRuleSnapshot;
  readonly probability: number;
  readonly scopedPaths: readonly string[];
  readonly locations: readonly FindingLocation[];
}

/** One built-in check finding that reached `FAIL` in the evaluated turn. */
export interface RemediationBuiltInFinding {
  readonly checkId: string;
  readonly severity: RuleSeverity;
  readonly probability: number;
  readonly scopedPaths: readonly string[];
  readonly locations: readonly FindingLocation[];
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

/** One finding as the agent sees it: ids, the rule's own text, severity, probability and where it failed. */
export interface DeliveryFinding {
  readonly id: string;
  readonly kind: "RULE" | "BUILT_IN";
  readonly description: string;
  readonly severity: string;
  readonly probability: number;
  readonly violation: string;
  readonly allowed: string;
  readonly locations: readonly FindingLocation[];
}

/**
 * Every `FAIL` finding of a unit as a delivery shows it, bounded: at most
 * `DELIVERY_MAX_FINDINGS` findings with bounded text, and how many were left out.
 */
export interface DeliveryFindings {
  readonly findings: readonly DeliveryFinding[];
  readonly omitted: number;
}

/** The framed message of one remediation delivery; `strategyText` is `null` when there is no proposal. */
export interface AgentDeliveryInput {
  readonly unit: string;
  readonly findings: readonly DeliveryFinding[];
  readonly omitted: number;
  readonly strategyText: string | null;
}

/** What a host knows when it decides whether to message the agent about a unit with a `FAIL`. */
export interface AgentDeliveryDecisionInput {
  readonly agentOptIn: boolean;
  readonly fromDelivery: boolean;
  readonly deliveredInSession: number;
}
