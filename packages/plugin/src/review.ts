import {
  DEFAULT_EVIDENCE_POLICY,
  aggregateReview,
  evaluateBuiltIns,
  evaluateRules,
  type GateConfigResult,
  parseRules,
  resolveGateConfig,
  type ReviewResult,
  type Turn,
  type UnavailableReason,
} from "@jevguard/core";
import {
  parsePolicyConfig,
  type PolicyLoadResult,
  type PolicyLoader,
} from "@jevguard/opencode-adapter";
import { presentReview } from "./present";
import { reviewLevelUnavailable } from "./review-result";
import type { ReviewDependencies } from "./types";

type ConfigValue =
  | { readonly status: "VALUE"; readonly value: unknown }
  | { readonly status: "INVALID" };

/**
 * Reviews one attributed turn: read the fixed policy paths once, then run the local
 * rule lane and the single built-in batch concurrently and present exactly one
 * aggregate. A rejected loader or rule/config failure degrades only the rule lane to a
 * review-level `UNAVAILABLE` and never suppresses the built-in batch. Rules stay
 * sequential inside their lane, so a turn submits one request per rule plus one batch
 * request to the shared Jev port, whose concurrency wrapper caps in-flight calls. The
 * final results are rules in source order, then scope creep, then complexity,
 * regardless of completion timing.
 */
export async function reviewAttributedTurn(
  turn: Turn,
  dependencies: ReviewDependencies,
): Promise<void> {
  const loaded = await loadPolicy(dependencies.policy);
  const builtInInput = { turn, evidencePolicy: DEFAULT_EVIDENCE_POLICY };

  const [ruleResults, builtIns] = await Promise.all([
    evaluateRuleLane(turn, loaded, dependencies),
    evaluateBuiltIns(builtInInput, { jev: dependencies.jev }),
  ]);

  const review = aggregateReview(turn.id, [
    ...ruleResults,
    builtIns.scopeCreep,
    builtIns.complexity,
  ]);

  await presentReview(dependencies.presenter, review);
}

async function evaluateRuleLane(
  turn: Turn,
  loaded: PolicyLoadResult | null,
  dependencies: Pick<ReviewDependencies, "jev">,
): Promise<readonly ReviewResult[]> {
  if (loaded === null) {
    return [reviewLevelUnavailable(turn.id, "INVALID_RULE")];
  }

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
