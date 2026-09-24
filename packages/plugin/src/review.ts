import {
  aggregateReview,
  buildProposalRequest,
  DEFAULT_EVIDENCE_POLICY,
  evaluateBuiltIns,
  evaluateRules,
  type GateConfigResult,
  parseRules,
  type RemediationConfigResult,
  type RemediationProposalRequest,
  type ReviewResult,
  resolveGateConfig,
  resolveRemediationConfig,
  type RuleParseResults,
  type Turn,
  type UnavailableReason,
} from "@jevguard/core";
import {
  parsePolicyConfig,
  type PolicyLoadResult,
  type PolicyLoader,
} from "@jevguard/opencode-adapter";
import { presentReview } from "./present";
import { proposeForTurn } from "./remediation/propose";
import { reviewLevelUnavailable } from "./review-result";
import type { ReviewDependencies } from "./types";

type ConfigValue =
  | { readonly status: "VALUE"; readonly value: unknown }
  | { readonly status: "INVALID" };

/** Rule-lane results plus the parsed rule provenance the review result omits. */
interface RuleLaneReview {
  readonly results: readonly ReviewResult[];
  readonly rules: RuleParseResults;
}

/** Both validated configuration sections read from one `.jev/config.yaml` value. */
interface PolicyConfig {
  readonly gate: GateConfigResult;
  readonly remediation: RemediationConfigResult;
}

/**
 * Reviews one attributed turn: read the fixed policy paths once, then run the local
 * rule lane and the single built-in batch concurrently and present exactly one
 * aggregate. A rejected loader or rule/config failure degrades only the rule lane to a
 * review-level `UNAVAILABLE` and never suppresses the built-in batch. Rules stay
 * sequential inside their lane, so a turn submits one request per rule plus one batch
 * request to the shared Jev port, whose concurrency wrapper caps in-flight calls. The
 * final results are rules in source order, then scope creep, then complexity,
 * regardless of completion timing. After presentation, an enabled and valid
 * remediation config builds one aggregate proposal request for the whole turn and
 * schedules at most one automatic proposal. This review never injects into agent
 * context.
 */
export async function reviewAttributedTurn(
  turn: Turn,
  sessionID: string,
  dependencies: ReviewDependencies,
): Promise<void> {
  const loaded = await loadPolicy(dependencies.policy);
  const config = readPolicyConfig(loaded);
  const builtInInput = { turn, evidencePolicy: DEFAULT_EVIDENCE_POLICY };

  const [ruleLane, builtIns] = await Promise.all([
    evaluateRuleLane(turn, loaded, config.gate, dependencies),
    evaluateBuiltIns(builtInInput, { jev: dependencies.jev }),
  ]);

  const review = aggregateReview(turn.id, [
    ...ruleLane.results,
    builtIns.scopeCreep,
    builtIns.complexity,
  ]);

  await presentReview(dependencies.presenter, review);

  const request = buildAggregateRequest(turn, sessionID, ruleLane, review.results, config);

  await proposeForTurn(request, dependencies);
}

function buildAggregateRequest(
  turn: Turn,
  sessionID: string,
  ruleLane: RuleLaneReview,
  results: readonly ReviewResult[],
  config: PolicyConfig,
): RemediationProposalRequest | null {
  if (config.remediation.status !== "VALID") {
    return null;
  }

  return buildProposalRequest({
    turn,
    sessionID,
    rules: ruleLane.rules,
    results,
    config: config.remediation.config,
  });
}

async function evaluateRuleLane(
  turn: Turn,
  loaded: PolicyLoadResult | null,
  gate: GateConfigResult,
  dependencies: Pick<ReviewDependencies, "jev">,
): Promise<RuleLaneReview> {
  if (loaded === null) {
    return ruleLaneUnavailable(turn.id, "INVALID_RULE");
  }

  if (loaded.status === "FAILED") {
    const reason: UnavailableReason =
      loaded.reason === "CONFIG_READ_FAILURE" ? "INVALID_CONFIG" : "INVALID_RULE";

    return ruleLaneUnavailable(turn.id, reason);
  }

  const rules = loaded.source.rules;

  if (rules === null) {
    return ruleLaneUnavailable(turn.id, "INVALID_RULE");
  }

  const parsedRules = parseRules(rules);

  const review = await evaluateRules(
    {
      turn,
      rules: parsedRules,
      gateConfig: gate,
      evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    },
    { jev: dependencies.jev },
  );

  return { results: review.results, rules: parsedRules };
}

function ruleLaneUnavailable(turnId: string, reason: UnavailableReason): RuleLaneReview {
  return { results: [reviewLevelUnavailable(turnId, reason)], rules: [] };
}

/**
 * Reads the policy loader once for the rule lane. A rejected promise is an unknown
 * infrastructure failure, contained here as `null` so it can degrade only the rule
 * lane and never reach the built-in lane or the presenter.
 */
async function loadPolicy(policy: PolicyLoader): Promise<PolicyLoadResult | null> {
  try {
    return await policy.load();
  } catch {
    return null;
  }
}

function readPolicyConfig(loaded: PolicyLoadResult | null): PolicyConfig {
  if (loaded === null || loaded.status === "FAILED") {
    return invalidPolicyConfig();
  }

  const value = readConfigValue(loaded.source.config);

  if (value.status === "INVALID") {
    return invalidPolicyConfig();
  }

  const gate = resolveGateConfig(value.value);
  const remediation = resolveRemediationConfig(value.value);

  if (gate.status === "INVALID" || remediation.status === "INVALID") {
    return invalidPolicyConfig();
  }

  return { gate, remediation };
}

function invalidPolicyConfig(): PolicyConfig {
  return {
    gate: { status: "INVALID", reason: "INVALID_CONFIG" },
    remediation: { status: "INVALID", reason: "INVALID_CONFIG" },
  };
}

function readConfigValue(config: string | null): ConfigValue {
  if (config === null) {
    return { status: "VALUE", value: null };
  }

  const parsed = parsePolicyConfig(config);

  return parsed.status === "PARSED"
    ? { status: "VALUE", value: parsed.value }
    : { status: "INVALID" };
}
