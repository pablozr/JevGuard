import {
  checkRules,
  type JevEvaluationPort,
  type PolicyLoader,
  type RuleReviewResult,
  type Turn,
  type TurnReview,
} from "@jevguard/core";
import { parsePolicyConfig } from "@jevguard/node-infra";
import type { ClaudeReviewHandoff } from "../../packages/claude-code-adapter/src/capture/types";
import { reviewHandoff } from "../../packages/claude-code-adapter/src/worker/review-handoff";
import type { WorkerDependencies } from "../../packages/claude-code-adapter/src/worker/types";
import { reviewAttributedTurn } from "../../packages/opencode-adapter/src/runtime/review";
import type { ReviewDependencies } from "../../packages/opencode-adapter/src/runtime/types";
import { STARTER_RULES } from "../../packages/cli/src/setup/scaffold";
import type { HostId } from "./args";

/**
 * The benchmark drives the real review entries, not a copy of them: the accuracy pass
 * calls the core rule lane, and each host probe calls the same function its plugin or
 * hook calls. Remediation is switched off in the probe config so a benchmark review
 * never opens a child session or writes a proposal.
 */

/**
 * The documented default gate plus `auto_propose: false`: the review runs exactly
 * with the default thresholds, and a FAIL case never opens a proposer session during
 * a benchmark run.
 */
export const BENCHMARK_CONFIG_TEXT = [
  "version: 1",
  "thresholds:",
  "  error:",
  "    warn: 0.4",
  "    fail: 0.7",
  "  warning:",
  "    warn: 0.6",
  "remediation:",
  "  auto_propose: false",
  "",
].join("\n");

export function createPolicyLoader(): PolicyLoader {
  return {
    async load() {
      return {
        status: "LOADED",
        source: { rules: STARTER_RULES, config: BENCHMARK_CONFIG_TEXT },
      };
    },
  };
}

export interface RuleObservation {
  readonly observed: "PASS" | "WARN" | "FAIL" | "SKIPPED" | "UNAVAILABLE";
  readonly probability: number | null;
  readonly reason: string | null;
}

/** One callable review path: `core` filters to the case's rule; hosts review the whole turn. */
export interface ReviewRunner {
  readonly host: string;
  readonly review: (turn: Turn, ruleId: string) => Promise<TurnReview>;
}

export function createCoreRunner(jev: JevEvaluationPort): ReviewRunner {
  const policy = createPolicyLoader();

  return {
    host: "core",
    async review(turn, ruleId) {
      const outcome = await checkRules(
        { turn, ruleId },
        { policy, parseConfig: parsePolicyConfig, jev },
      );

      if (outcome.status === "RULE_NOT_FOUND") {
        throw new Error(`rule ${ruleId} was not parsed from the starter pack`);
      }

      return outcome.review;
    },
  };
}

export function createHostRunner(host: HostId, jev: JevEvaluationPort): ReviewRunner {
  return host === "opencode" ? createOpenCodeRunner(jev) : createClaudeCodeRunner(jev);
}

function createOpenCodeRunner(jev: JevEvaluationPort): ReviewRunner {
  const holder: { review: TurnReview | null } = { review: null };
  const dependencies = openCodeDependencies(jev, (review) => {
    holder.review = review;
  });

  return {
    host: "opencode",
    async review(turn) {
      holder.review = null;
      await reviewAttributedTurn(turn, "benchmark-session", { fromDelivery: false }, dependencies);

      if (holder.review === null) {
        throw new Error("the OpenCode review path presented nothing for the unit");
      }

      return holder.review;
    },
  };
}

function createClaudeCodeRunner(jev: JevEvaluationPort): ReviewRunner {
  const dependencies = claudeCodeDependencies(jev);

  return {
    host: "claude-code",
    async review(turn) {
      const result = await reviewHandoff(buildHandoff(turn), dependencies, { proposals: false });

      return result.review;
    },
  };
}

/** Reads the case rule's result; a review-level failure becomes an operational result. */
export function ruleObservation(review: TurnReview, ruleId: string): RuleObservation {
  const result = review.results.find(
    (candidate): candidate is RuleReviewResult =>
      candidate.kind === "RULE" && candidate.ruleId === ruleId,
  );

  if (result === undefined) {
    const reviewLevel = review.results.find((candidate) => candidate.kind === "REVIEW");

    return {
      observed: "UNAVAILABLE",
      probability: null,
      reason: reviewLevel?.outcome === "UNAVAILABLE" ? reviewLevel.reason : "RULE_NOT_EVALUATED",
    };
  }

  if (result.outcome === "PASS" || result.outcome === "WARN" || result.outcome === "FAIL") {
    return { observed: result.outcome, probability: result.violationProbability, reason: null };
  }

  return { observed: result.outcome, probability: null, reason: result.reason };
}

function openCodeDependencies(
  jev: JevEvaluationPort,
  present: (review: TurnReview) => void,
): ReviewDependencies {
  const policy = createPolicyLoader();

  return {
    policy,
    jev,
    presenter: {
      async present(review) {
        present(review);

        return { log: "DELIVERED", toast: "DELIVERED" };
      },
    },
    operational: { write: async () => "DELIVERED" },
    remediation: null,
    idle: { untilIdle: async () => "IDLE", notifyIdle: () => undefined },
    proposals: {
      claim: () => false,
      registerChildSession: () => undefined,
      isChildSession: () => false,
    },
    proposalFacade: {
      originModel: async () => null,
      createChildSession: async () => "",
      prompt: async () => undefined,
      readProposal: async () => null,
      interrupt: async () => undefined,
    },
    navigator: { navigate: async () => "DELIVERED" },
    notifier: {
      proposalPreparing: async () => "DELIVERED",
      proposalReady: async () => "DELIVERED",
      proposalFailed: async () => "DELIVERED",
    },
    failures: { write: async () => "DELIVERED" },
    childExecutions: { wait: async () => "SUCCEEDED", settle: () => undefined },
    proposalTimeoutMs: 120_000,
  };
}

function claudeCodeDependencies(jev: JevEvaluationPort): WorkerDependencies {
  const policy = createPolicyLoader();

  return {
    handoffDirectory: "",
    files: {
      list: () => [],
      read: () => null,
      modifiedMs: () => null,
      sizeBytes: () => null,
      rename: () => "FAILED",
      remove: () => undefined,
      ensureDirectory: () => undefined,
    },
    now: () => new Date(),
    history: { append: async () => undefined },
    feed: { started: () => undefined, recorded: () => true, sweep: () => undefined },
    policyFor: () => policy,
    parseConfig: parsePolicyConfig,
    remediationFor: () => ({ status: "DISABLED" }),
    proposals: { write: () => "FAILED", remove: () => undefined, sweep: () => undefined },
    jevFor: () => jev,
    deadline: { race: raceWithDeadline },
    log: () => undefined,
    reviewDeadlineMs: 120_000,
  };
}

function buildHandoff(turn: Turn): ClaudeReviewHandoff {
  return {
    version: 1,
    turnId: turn.id,
    sessionId: "benchmark-session",
    ordinal: 0,
    projectRoot: "/benchmark",
    closedAt: new Date().toISOString(),
    shellCoverage: [],
    epoch: "benchmark",
    resolution: { status: "TURN", turn },
  };
}

/** The worker's real deadline shape, so the measured review includes it. */
async function raceWithDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
): Promise<{ readonly status: "DONE"; readonly value: T } | { readonly status: "DEADLINE" }> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<{ readonly status: "DEADLINE" }>((resolve) => {
    timer = setTimeout(() => resolve({ status: "DEADLINE" }), milliseconds);
  });

  const result = await Promise.race([
    work.then((value) => ({ status: "DONE" as const, value })),
    timeout,
  ]);

  if (timer !== undefined) clearTimeout(timer);

  return result;
}
