import {
  DEFAULT_EVIDENCE_POLICY,
  evaluateRules,
  type GateConfigResult,
  parseRules,
  resolveGateConfig,
  type Turn,
  type UnavailableReason,
} from "@jevguard/core";
import { parsePolicyConfig, type ReviewPresenter } from "@jevguard/opencode-adapter";
import { presentReview } from "./present";
import { unavailableReview } from "./review-result";
import type { ReviewDependencies } from "./types";

type ConfigValue =
  | { readonly status: "VALUE"; readonly value: unknown }
  | { readonly status: "INVALID" };

/**
 * Reviews one attributed turn: load the fixed policy paths once, parse every rule
 * block and resolve the config once, then evaluate the rules sequentially through
 * core and present exactly one aggregate review. Invalid individual rule blocks and
 * an invalid config become per-rule results without suppressing their siblings.
 */
export async function reviewAttributedTurn(
  turn: Turn,
  dependencies: ReviewDependencies,
): Promise<void> {
  const loaded = await dependencies.policy.load();

  if (loaded.status === "FAILED") {
    const reason: UnavailableReason =
      loaded.reason === "CONFIG_READ_FAILURE" ? "INVALID_CONFIG" : "INVALID_RULE";

    await presentUnavailable(dependencies.presenter, turn.id, reason);
    return;
  }

  const rules = loaded.source.rules;

  if (rules === null) {
    await presentUnavailable(dependencies.presenter, turn.id, "INVALID_RULE");
    return;
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

  await presentReview(dependencies.presenter, review);
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

async function presentUnavailable(
  presenter: ReviewPresenter,
  turnId: string,
  reason: UnavailableReason,
): Promise<void> {
  await presentReview(presenter, unavailableReview(turnId, null, reason));
}
