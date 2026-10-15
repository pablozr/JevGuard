import type { Turn, UnavailableReason } from "../domain/types";
import { evaluateRules } from "../evaluation/evaluate-rules";
import { DEFAULT_EVIDENCE_POLICY } from "../evidence/defaults";
import type { GateConfigResult } from "../gate/types";
import type { PolicyLoadResult } from "../ports/types";
import { parseRules } from "../rules/parse-rules";
import type { RuleParseResults } from "../rules/types";
import type { ReviewTurnDependencies, RuleCandidateResolution, RuleLaneReview } from "./types";
import { reviewLevelUnavailable } from "./unavailable";

export function resolveRuleCandidates(
  turnId: string,
  loaded: PolicyLoadResult | null,
): RuleCandidateResolution {
  if (loaded === null) {
    return unavailableResolution(turnId, "INVALID_RULE");
  }

  if (loaded.status === "FAILED") {
    const reason: UnavailableReason =
      loaded.reason === "CONFIG_READ_FAILURE" ? "INVALID_CONFIG" : "INVALID_RULE";

    return unavailableResolution(turnId, reason);
  }

  const rules = loaded.source.rules;

  if (rules === null) {
    return unavailableResolution(turnId, "INVALID_RULE");
  }

  return { status: "RULES", rules: parseRules(rules) };
}

export async function evaluateRuleCandidates(
  turn: Turn,
  rules: RuleParseResults,
  gate: GateConfigResult,
  dependencies: Pick<ReviewTurnDependencies, "jev">,
): Promise<RuleLaneReview> {
  const review = await evaluateRules(
    {
      turn,
      rules,
      gateConfig: gate,
      evidencePolicy: DEFAULT_EVIDENCE_POLICY,
    },
    { jev: dependencies.jev },
  );

  return { results: review.results, rules };
}

function ruleLaneUnavailable(turnId: string, reason: UnavailableReason): RuleLaneReview {
  return { results: [reviewLevelUnavailable(turnId, reason)], rules: [] };
}

function unavailableResolution(turnId: string, reason: UnavailableReason): RuleCandidateResolution {
  return { status: "UNAVAILABLE", lane: ruleLaneUnavailable(turnId, reason) };
}
