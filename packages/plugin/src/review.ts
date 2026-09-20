import {
  DEFAULT_EVIDENCE_POLICY,
  evaluateRule,
  type GateConfig,
  type ParsedRule,
  parseRule,
  resolveGateConfig,
  type ReviewResult,
  type Turn,
  type UnavailableReason,
} from "@jevguard/core";
import { parsePolicyConfig, type ReviewPresenter } from "@jevguard/opencode-adapter";
import { presentResult } from "./present";
import { unavailableResult } from "./review-result";
import type { ReviewDependencies } from "./types";

type RuleRead =
  | { readonly status: "PARSED"; readonly rule: ParsedRule }
  | { readonly status: "INVALID" };

type ConfigRead =
  | { readonly status: "VALID"; readonly config: GateConfig }
  | { readonly status: "INVALID" };

type ConfigValue =
  | { readonly status: "VALUE"; readonly value: unknown }
  | { readonly status: "INVALID" };

/**
 * Reviews one attributed turn: load the fixed policy paths once, parse the single
 * rule and config once, then evaluate at most one Jev judgment and present the
 * one resulting review.
 */
export async function reviewAttributedTurn(
  turn: Turn,
  dependencies: ReviewDependencies,
): Promise<void> {
  const loaded = await dependencies.policy.load();

  if (loaded.status === "FAILED") {
    const reason: UnavailableReason =
      loaded.reason === "CONFIG_READ_FAILURE" ? "INVALID_CONFIG" : "INVALID_RULE";

    await presentUnavailable(dependencies.presenter, turn.id, null, reason);
    return;
  }

  const rule = readRule(loaded.source.rules);

  if (rule.status === "INVALID") {
    await presentUnavailable(dependencies.presenter, turn.id, null, "INVALID_RULE");
    return;
  }

  const config = readConfig(loaded.source.config);

  if (config.status === "INVALID") {
    await presentUnavailable(dependencies.presenter, turn.id, rule.rule, "INVALID_CONFIG");
    return;
  }

  const result = await evaluateRule(
    {
      turn,
      rule: rule.rule,
      gateConfig: config.config,
      evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    },
    { jev: dependencies.jev },
  );

  await presentResult(dependencies.presenter, result);
}

function readRule(rules: string | null): RuleRead {
  if (rules === null) {
    return { status: "INVALID" };
  }

  const parsed = parseRule(rules);

  return parsed.status === "PARSED"
    ? { status: "PARSED", rule: parsed.rule }
    : { status: "INVALID" };
}

function readConfig(config: string | null): ConfigRead {
  const value = readConfigValue(config);

  if (value.status === "INVALID") {
    return { status: "INVALID" };
  }

  const resolved = resolveGateConfig(value.value);

  return resolved.status === "VALID"
    ? { status: "VALID", config: resolved.config }
    : { status: "INVALID" };
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
  rule: ParsedRule | null,
  reason: UnavailableReason,
): Promise<void> {
  const result: ReviewResult = unavailableResult(turnId, rule, reason);

  await presentResult(presenter, result);
}
