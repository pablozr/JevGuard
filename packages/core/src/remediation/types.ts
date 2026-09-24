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

/** MVP proposal trigger. `WARN` and every operational outcome never trigger. */
export type ProposalTrigger = "FAIL";

/**
 * Strict remediation policy. Absent configuration uses the defaults: auto-propose is
 * enabled for `FAIL` with the bundled proposer model.
 */
export interface RemediationConfig {
  readonly autoPropose: boolean;
  readonly proposeOn: readonly ProposalTrigger[];
  readonly model: string;
}

export const DEFAULT_REMEDIATION_CONFIG: RemediationConfig = {
  autoPropose: true,
  proposeOn: ["FAIL"],
  model: "opencode/gpt-5.6-luna",
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
  readonly model: string;
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
