import { evaluateBuiltIns } from "../builtins/evaluate-builtins";
import type { Turn, UnavailableReason } from "../domain/types";
import { evaluateRules } from "../evaluation/evaluate-rules";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults";
import { resolveGateConfig } from "../gate/config";
import type { GateConfigResult } from "../gate/types";
import type { PolicyConfigParser, PolicyLoader, PolicyLoadResult } from "../ports/types";
import { resolveRemediationConfig } from "../remediation/config";
import { parseRules } from "../rules/parse-rules";
import { aggregateReview } from "./aggregate";
import type {
  ConfigValue,
  PolicyConfig,
  ReviewTurnDependencies,
  RuleLaneReview,
  TurnReviewOutcome,
} from "./types";
import { reviewLevelUnavailable } from "./unavailable";

/**
 * Reviews one attributed turn: read the fixed policy paths once, then run the local
 * rule lane and the single built-in batch concurrently and aggregate them. A rejected
 * loader or rule/config failure degrades only the rule lane to a review-level
 * `UNAVAILABLE` and never suppresses the built-in batch. The final results are rules
 * in source order, then scope creep, then complexity, regardless of completion timing.
 * Presentation and remediation stay with the host.
 */
export async function reviewTurn(
  turn: Turn,
  dependencies: ReviewTurnDependencies,
): Promise<TurnReviewOutcome> {
  const loaded = await loadPolicy(dependencies.policy);
  const config = readPolicyConfig(loaded, dependencies.parseConfig);
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

  return { review, rules: ruleLane.rules, remediation: config.remediation };
}

async function evaluateRuleLane(
  turn: Turn,
  loaded: PolicyLoadResult | null,
  gate: GateConfigResult,
  dependencies: Pick<ReviewTurnDependencies, "jev">,
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

function readPolicyConfig(
  loaded: PolicyLoadResult | null,
  parseConfig: PolicyConfigParser,
): PolicyConfig {
  if (loaded === null || loaded.status === "FAILED") {
    return invalidPolicyConfig();
  }

  const value = readConfigValue(loaded.source.config, parseConfig);

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

function readConfigValue(config: string | null, parseConfig: PolicyConfigParser): ConfigValue {
  if (config === null) {
    return { status: "VALUE", value: null };
  }

  const parsed = parseConfig(config);

  return parsed.status === "PARSED"
    ? { status: "VALUE", value: parsed.value }
    : { status: "INVALID" };
}
