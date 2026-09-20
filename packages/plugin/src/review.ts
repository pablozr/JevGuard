import {
  DEFAULT_EVIDENCE_POLICY,
  aggregateReview,
  evaluateRules,
  evaluateScopeCreep,
  type GateConfigResult,
  parseRules,
  resolveGateConfig,
  type ReviewResult,
  type Turn,
  type UnavailableReason,
} from "@jevguard/core";
import { parsePolicyConfig, type PolicyLoadResult } from "@jevguard/opencode-adapter";
import { presentReview } from "./present";
import { reviewLevelUnavailable } from "./review-result";
import type { ReviewDependencies } from "./types";

type ConfigValue =
  | { readonly status: "VALUE"; readonly value: unknown }
  | { readonly status: "INVALID" };

/**
 * Reviews one attributed turn: load the fixed policy paths once, run the local rule
 * lane and the scope-creep built-in concurrently, then present exactly one aggregate.
 * A loader or rule/config failure only degrades the rule lane; the built-in always
 * runs. Rules stay sequential inside their lane, so a turn has at most the built-in
 * and one rule in flight, and the final results are rules in source order then scope
 * creep.
 */
export async function reviewAttributedTurn(
  turn: Turn,
  dependencies: ReviewDependencies,
): Promise<void> {
  const loaded = await dependencies.policy.load();

  const [ruleResults, scopeCreepResult] = await Promise.all([
    evaluateRuleLane(turn, loaded, dependencies),
    evaluateScopeCreep(
      { turn, evidencePolicy: DEFAULT_EVIDENCE_POLICY },
      { jev: dependencies.jev },
    ),
  ]);

  const review = aggregateReview(turn.id, [...ruleResults, scopeCreepResult]);

  await presentReview(dependencies.presenter, review);
}

async function evaluateRuleLane(
  turn: Turn,
  loaded: PolicyLoadResult,
  dependencies: Pick<ReviewDependencies, "jev">,
): Promise<readonly ReviewResult[]> {
  if (loaded.status === "FAILED") {
    const reason: UnavailableReason =
      loaded.reason === "CONFIG_READ_FAILURE" ? "INVALID_CONFIG" : "INVALID_RULE";

    return [reviewLevelUnavailable(turn.id, reason)];
  }

  const rules = loaded.source.rules;

  if (rules === null) {
    return [reviewLevelUnavailable(turn.id, "INVALID_RULE")];
  }

  const parsedRules = parseRules(rules);
  const gateConfig = readGateConfig(loaded.source.config);

  const review = await evaluateRules(
    {
      turn,
      rules: parsedRules,
      gateConfig,
      evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    },
    { jev: dependencies.jev },
  );

  return review.results;
}

function readGateConfig(config: string | null): GateConfigResult {
  const value = readConfigValue(config);

  if (value.status === "INVALID") {
    return { status: "INVALID", reason: "INVALID_CONFIG" };
  }

  return resolveGateConfig(value.value);
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
